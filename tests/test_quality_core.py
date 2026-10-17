"""Precisão e semântica de valores usados no diagnóstico amostral."""

from datetime import datetime, timezone
from decimal import Decimal
import unittest

from dataqore_engine.core.quality import (UnavailableValue, compare_profiles, profile_rows,
                     type_family, validate_saved_result, values_equal)


class QualityTests(unittest.TestCase):
    def test_nan_unknown_and_empty_string_are_not_matches(self):
        self.assertIsNone(values_equal(float('nan'), float('nan')))
        self.assertIsNone(values_equal(object(), object()))
        self.assertIsNone(values_equal(UnavailableValue('large'), UnavailableValue('large')))
        self.assertFalse(values_equal(None, ''))
        self.assertFalse(values_equal(' A ', 'A'))
        self.assertFalse(values_equal('A', 'a'))
        self.assertFalse(values_equal('1', 1))

    def test_preserves_submicrosecond_temporal_precision(self):
        meta = {'type': 'datetime2'}
        self.assertFalse(values_equal('2026-10-16T12:00:00.1234561', '2026-10-16T12:00:00.1234562', meta, meta))
        self.assertTrue(values_equal('2026-10-16T12:00:00.1234560', datetime(2026, 10, 16, 12, 0, 0, 123456), meta, meta))
        self.assertTrue(values_equal('2026-10-16T09:00:00-03:00', datetime(2026, 10, 16, 12, tzinfo=timezone.utc), meta, meta))
        self.assertIsNone(values_equal('2026-10-16T12:00:00', '2026-10-16T12:00:00Z', meta, meta))

    def test_decimal_statistics_and_quantiles(self):
        profile = profile_rows({'n': {'type': 'numeric'}}, ['n'], [(Decimal(v),) for v in ('1', '2', '3', '4')])
        m = profile['metrics']['n']
        self.assertEqual(m['mean'], Decimal('2.5'))
        self.assertEqual(m['median'], Decimal('2.5'))
        self.assertEqual((m['q25'], m['q75']), (Decimal('1.75'), Decimal('3.25')))
        self.assertAlmostEqual(float(m['stddev']), 1.118033988749895)

    def test_unknown_values_have_explicit_denominators(self):
        meta = {'n': {'type': 'numeric'}}
        p = profile_rows(meta, ['n'], [(1,), (None,), (UnavailableValue('large'),), (Decimal('NaN'),)])
        m = p['metrics']['n']
        self.assertEqual((m['sample_count'], m['null_count'], m['distinct_denominator']), (4, 1, 1))
        self.assertEqual(m['distinct_rate'], 1)
        result = {'sources': [{k: v for k, v in p.items() if not k.startswith('sample_') or k == 'sample_size'}] * 2}
        self.assertEqual(validate_saved_result(result)['status'], 'internally_consistent')
        comparison = compare_profiles(p, p)[0]
        self.assertEqual(comparison['status'], 'inconclusive')
        self.assertEqual(comparison['denominators']['reference']['distinct_rate'], 1)

    def test_numeric_tolerances_are_explicit(self):
        self.assertFalse(values_equal(Decimal('1.0001'), Decimal('1')))
        self.assertTrue(values_equal(Decimal('1.0001'), Decimal('1'), absolute_tolerance=Decimal('.001')))
        self.assertFalse(values_equal('1.0001', '1', absolute_tolerance=Decimal('.001')))
        with self.assertRaises(ValueError):
            values_equal(1, 1, relative_tolerance=-1)

    def test_json_arrays_and_unsigned_numeric_types(self):
        meta = {'type': 'jsonb'}
        self.assertTrue(values_equal('{"a":1,"b":[2,3]}', {'b': [2, 3], 'a': 1}, meta, meta))
        self.assertEqual(type_family('double unsigned'), 'float')
        self.assertEqual(type_family('decimal(10,2) unsigned'), 'decimal')
