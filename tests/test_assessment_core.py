"""Percentuais, cobertura, evidências temporárias e ausência de falsos 100%."""

import io
import json
import sqlite3
import unittest
from contextlib import redirect_stdout
from decimal import Decimal

from dataqore_engine.core.assessment import combine_quality, quality_assessment
from dataqore_engine.storage import json_safe as _yaml_safe
from dataqore_engine.core.comparison_engine import execute_comparison
from dataqore_engine.core.quality import UnavailableValue, profile_rows, validate_saved_result
from dataqore_engine.core.comparison_engine import prepare_sources


class AssessmentTests(unittest.TestCase):
    def source(self, rows, ddl='CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)'):
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute(ddl)
        if rows:
            conn.executemany('INSERT INTO records VALUES (' + ','.join('?' for _ in rows[0]) + ')', rows)
        return {'connection': 'local', 'creds': {'type': 'sqlite'}, 'conn': conn, 'schema': '', 'table': 'records'}

    def compare(self, left, right, **kwargs):
        return execute_comparison([self.source(left), self.source(right)], sample_size=30, **kwargs)

    def test_nullable_null_matches_and_does_not_reduce_quality(self):
        result = self.compare([(1, None), (2, None)], [(1, None), (2, None)])
        agreement = result['indicators']['agreement']
        quality = result['indicators']['quality']['overall']
        self.assertEqual((agreement['equal_cells'], agreement['evaluated'], agreement['total']), (4, 4, 4))
        self.assertEqual(agreement['percentage'], 100)
        self.assertEqual(quality['percentage'], 100)
        self.assertEqual(quality['coverage_percentage'], 100)
        self.assertEqual(result['format_version'], 4)

    def test_value_difference_has_explicit_denominator(self):
        result = self.compare([(1, 'a'), (2, 'b')], [(1, 'a'), (2, 'different')])
        score = result['indicators']['agreement']
        self.assertEqual((score['passed'], score['evaluated'], score['failed']), (3, 4, 1))
        self.assertEqual(score['percentage'], 75)

    def test_missing_records_on_both_sides_reduce_concordance(self):
        result = self.compare([(1, 'same'), (2, 'left')], [(1, 'same'), (3, 'right')])
        score = result['indicators']['agreement']
        self.assertEqual(score['missing_positions'], 4)
        self.assertEqual((score['passed'], score['evaluated'], score['total']), (2, 6, 6))
        self.assertEqual(score['percentage'], Decimal('33.3333'))

    def test_missing_column_is_not_dropped_from_score(self):
        left = self.source([(1, 'value')])
        right = self.source([(1,)], 'CREATE TABLE records (id INTEGER PRIMARY KEY)')
        result = execute_comparison([left, right], sample_size=30)
        score = result['indicators']['agreement']
        self.assertEqual(score['percentage'], 50)
        self.assertEqual((score['missing_positions'], score['evaluated']), (1, 2))

    def test_incompatible_column_is_pending_and_percentage_is_partial(self):
        left = self.source([(1, 42)], 'CREATE TABLE records (id INTEGER PRIMARY KEY, value INTEGER)')
        right = self.source([(1, '42')])
        result = execute_comparison([left, right], sample_size=30)
        score = result['indicators']['agreement']
        self.assertEqual((score['passed'], score['evaluated'], score['total']), (1, 1, 2))
        self.assertEqual(score['coverage_percentage'], 50)
        self.assertEqual(score['status'], 'partial')

    def test_unavailable_cells_do_not_become_equal_or_quality_failures(self):
        result = self.compare([(1, 'x' * 70000)], [(1, 'x' * 70000)])
        agreement = result['indicators']['agreement']
        self.assertEqual(agreement['pending'], 1)
        self.assertEqual(agreement['coverage_percentage'], 50)
        self.assertEqual(agreement['status'], 'partial')
        quality = result['indicators']['quality']['overall']
        self.assertEqual(quality['status'], 'partial')
        self.assertEqual(quality['failed'], 0)
        self.assertLess(quality['coverage_percentage'], 100)

    def test_empty_samples_have_no_percentage(self):
        result = self.compare([], [])
        self.assertIsNone(result['indicators']['agreement']['percentage'])
        self.assertIsNone(result['indicators']['quality']['overall']['percentage'])

    def test_no_keys_no_concordance_but_independent_previews(self):
        ddl = 'CREATE TABLE records (value TEXT)'
        previews = []
        result = execute_comparison([self.source([('a',)], ddl), self.source([('b',)], ddl)],
                                    preview_callback=previews.append)
        self.assertIsNone(result['indicators']['agreement']['percentage'])
        self.assertEqual(result['indicators']['agreement']['reason'], 'no_safe_key_alignment')
        self.assertEqual(previews[0]['mode'], 'independent_random')
        self.assertEqual(len(previews[0]['sources']), 2)

    def test_preview_is_limited_and_never_part_of_serialized_result(self):
        left = [(i, 'PRIVATE_SOURCE_VALUE') for i in range(10)]
        right = [(i, 'PRIVATE_TARGET_VALUE') for i in range(10)]
        previews = []
        result = self.compare(left, right, preview_callback=previews.append)
        self.assertEqual(len(previews[0]['pairs']), 5)
        self.assertEqual(len(previews[0]['differences']), 5)
        self.assertIn('PRIVATE_SOURCE_VALUE', repr(previews))
        serialized = json.dumps(_yaml_safe(result))
        self.assertNotIn('PRIVATE_SOURCE_VALUE', serialized)
        self.assertNotIn('PRIVATE_TARGET_VALUE', serialized)
        self.assertNotIn('previews', serialized)


    def test_equal_bad_data_can_have_full_concordance_and_lower_quality(self):
        # Dados que contrariam a declaração são simulados no perfil puro.
        meta = {'id': {'type': 'integer', 'nullable': False, 'primary_key': True},
                'value': {'type': 'numeric', 'nullable': False}}
        p = profile_rows(meta, ['id', 'value'], [(1, None), (2, 'bad')])
        assessed = quality_assessment(p)
        self.assertLess(assessed['percentage'], 100)
        self.assertEqual(assessed['rules']['required_fields']['failed'], 1)
        self.assertEqual(assessed['rules']['type_validity']['failed'], 1)
        self.assertEqual(assessed['pending'], 0)

    def test_equal_nulls_can_match_while_required_field_rule_fails(self):
        sources = [self.source([(1, None)]), self.source([(1, None)])]
        prepared = prepare_sources(sources)
        # Simula um contrato obrigatório sobre uma fonte cuja leitura retorna NULL.
        for source in prepared:
            source['columns']['value']['nullable'] = False
        result = execute_comparison(sources, prepared=prepared, sample_size=30)
        self.assertEqual(result['indicators']['agreement']['percentage'], 100)
        self.assertLess(result['indicators']['quality']['overall']['percentage'], 100)
        self.assertEqual(result['summary']['status'], 'difference_observed')

    def test_key_integrity_marks_every_duplicate_row(self):
        meta = {'id': {'type': 'integer', 'nullable': False, 'primary_key': True}}
        score = quality_assessment(profile_rows(meta, ['id'], [(1,), (1,), (2,)]))
        self.assertEqual(score['rules']['key_integrity']['passed'], 1)
        self.assertEqual(score['rules']['key_integrity']['failed'], 2)

    def test_quality_consolidation_sums_checks_not_percentages(self):
        meta = {'id': {'type': 'integer', 'nullable': False, 'primary_key': True}, 'v': {'type': 'numeric'}}
        a = profile_rows(meta, ['id', 'v'], [(1, 'bad')])
        b = profile_rows(meta, ['id', 'v'], [(1, 1), (2, 'bad'), (3, 'bad')])
        quality = combine_quality([a, b])
        sources, combined = quality['sources'], quality['overall']
        self.assertEqual(combined['percentage'], Decimal('85.7143'))
        self.assertEqual((combined['passed'], combined['evaluated']), (18, 21))
        self.assertNotEqual(combined['percentage'], sum(s['percentage'] for s in sources) / 2)

    def test_no_supported_checks_is_not_evaluated(self):
        meta = {'v': {'type': 'unrecognized', 'nullable': True}}
        result = quality_assessment(profile_rows(meta, ['v'], [(object(),)]))
        self.assertIsNone(result['percentage'])
        self.assertEqual(result['pending'], 1)
        self.assertEqual(result['coverage_percentage'], 0)

    def test_numeric_finiteness_and_blank_text_rules(self):
        meta = {'v': {'type': 'numeric'}, 'text': {'type': 'text', 'nullable': False}}
        p = profile_rows(meta, ['v', 'text'], [(Decimal('NaN'), ''), (1, ' ')])
        result = quality_assessment(p)
        self.assertEqual(result['rules']['finite_numbers']['failed'], 1)
        self.assertEqual(result['rules']['required_fields']['failed'], 0)
        self.assertEqual(result['rules']['type_validity']['failed'], 0)

    def test_preview_callback_contract(self):
        for limit in (-1, 6, True):
            with self.assertRaises(ValueError):
                self.compare([(1, '')], [(1, '')], preview_limit=limit)
        with self.assertRaises(ValueError):
            self.compare([(1, '')], [(1, '')], preview_callback='not callable')

    def test_indicator_audit_survives_serialization_and_detects_corruption(self):
        result = _yaml_safe(self.compare([(1, 'a')], [(1, 'a')]))
        self.assertEqual(validate_saved_result(result)['status'], 'internally_consistent')
        result['indicators']['agreement']['percentage'] = '25'
        issues = validate_saved_result(result)['issues']
        self.assertTrue(any('agreement' in issue for issue in issues))

    def test_json_scalar_null_and_numeric_type_are_valid(self):
        meta = {'document': {'type': 'json'}}
        result = quality_assessment(profile_rows(meta, ['document'], [('null',), ('[1,2]',), ('{"a":1}',)]))
        self.assertEqual(result['rules']['type_validity']['failed'], 0)
        self.assertEqual(result['percentage'], 100)
