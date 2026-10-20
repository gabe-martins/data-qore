"""Motor para duas tabelas: descoberta, piloto, amostragem e diagnóstico."""

from collections import Counter
from datetime import datetime
from decimal import Decimal
import hashlib
from uuid import UUID, uuid4

from .db_adapters import get_adapter
from .quality import (NUMERIC_FAMILIES, name_map, profile_rows, type_family,
                     values_equal, compare_profiles, value_token)
from .sampling import SamplingOptions, pilot_size, plan_sample
from .query_audit import RecordingConnection
from .assessment import agreement_score, unaligned_agreement, combine_quality
from .comparison_preview import build_preview


def _family(info):
    return info.get('family') or type_family(info.get('type'))


def prepare_sources(selected, explicit_options=False):
    if len(selected) != 2:
        raise ValueError('Select exactly two tables for a comparison')
    sources = []
    for item in selected:
        events = []
        item = {**item, 'conn': RecordingConnection(item['conn'], events)}
        adapter = item.get('adapter') or get_adapter(item['creds']['type'])
        columns = adapter.metadata(item['conn'], item['schema'], item['table'])
        if not columns:
            raise ValueError(f"No column metadata for {item['table']}")
        if explicit_options and item.get('read_consistency') == 'transactional_snapshot_pending':
            cursor = item['conn'].cursor()
            try:
                cursor.execute("SELECT ENGINE FROM information_schema.tables WHERE table_schema = COALESCE(NULLIF(%s, ''), DATABASE()) AND table_name = %s", (item['schema'], item['table']))
                row = cursor.fetchone()
                item['read_consistency'] = 'stable_snapshot' if row and str(row[0]).lower() == 'innodb' else 'best_effort'
            finally:
                cursor.close()
        sources.append({**item, 'adapter': adapter, 'columns': columns, 'query_log': events,
                        'names': {} if explicit_options else name_map(columns),
                        'estimated_rows': adapter.estimate_rows(item['conn'], item['schema'], item['table'])})
    return sources


def _key_candidates(source):
    columns = source['columns']
    reverse = {physical: logical for logical, physical in source['names'].items()}
    primary = [reverse[name] for name, info in sorted(columns.items(),
               key=lambda pair: pair[1].get('primary_key_order') or 10**6) if info.get('primary_key')]
    result = [(primary, 'primary_key')] if primary else []
    groups = {}
    for name, info in columns.items():
        for group in info.get('unique_groups', []):
            groups.setdefault(group, []).append(reverse[name])
    for names in sorted(groups.values(), key=lambda group: (len(group), sorted(group))):
        if all(columns[source['names'][name]].get('nullable') is False for name in names):
            result.append((names, 'unique_constraint'))
    return result


def common_comparison_key(sources):
    if len(sources) != 2:
        return [], None
    right = _key_candidates(sources[1])
    supported = {'integer', 'decimal', 'text', 'binary', 'uuid', 'uniqueidentifier'}
    for keys, kind in _key_candidates(sources[0]):
        if not any(set(keys) == set(candidate) for candidate, _ in right):
            continue
        compatible = True
        for key in keys:
            families = {_family(source['columns'][source['names'][key]]) for source in sources}
            compatible &= (families <= {'integer', 'decimal'} or
                           families <= {'uuid', 'uniqueidentifier'} or
                           len(families) == 1 and families <= supported)
        if compatible:
            return keys, kind
    return [], None


def common_primary_key(sources):
    """Interface histórica; somente PKs. O planejador também reconhece UNIQUE."""
    if len(sources) != 2:
        return []
    keys, kind = common_comparison_key(sources)
    return keys if kind == 'primary_key' else []


def _capture(source, limit):
    names, rows = source['adapter'].fetch_random(source['conn'], source['schema'], source['table'],
                                               list(source['columns']), limit, metadata=source['columns'],
                                               **({'scope': source['scope']} if 'scope' in source else {}))
    return profile_rows(source['columns'], names, rows, allow_ambiguous=source.get('explicit_options', False))


def fetch_by_keys(source, keys, values):
    adapter = source.get('adapter') or get_adapter(source['creds']['type'])
    names, rows = adapter.fetch_keys(source['conn'], source['schema'], source['table'],
                                     list(source['columns']), [source['names'][key] for key in keys],
                                     values, metadata=source['columns'],
                                     **({'scope': source['scope']} if 'scope' in source else {}))
    return profile_rows(source['columns'], names, rows, allow_ambiguous=source.get('explicit_options', False))


def _key_token(value, info):
    family = _family(info)
    if value is None:
        raise ValueError('Null value in sampled comparison key')
    if family in {'integer', 'decimal'}:
        if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
            raise ValueError('Invalid numeric comparison key')
        number = Decimal(str(value))
        if not number.is_finite():
            raise ValueError('Nonfinite comparison key')
        return ('number', number)
    if family in {'uuid', 'uniqueidentifier'}:
        return ('uuid', UUID(str(value)).hex)
    if family == 'binary' and isinstance(value, (bytes, bytearray, memoryview)):
        return ('binary', bytes(value))
    if family == 'text' and isinstance(value, str):
        return ('text', value)
    raise ValueError('Unavailable or unsupported comparison key')


def _index(profile, source, keys):
    positions = [profile['sample_columns'].index(source['names'][key]) for key in keys]
    indexed, values = {}, {}
    for row in profile['sample_rows']:
        token = tuple(_key_token(row[position], source['columns'][source['names'][key]])
                      for key, position in zip(keys, positions))
        if token in indexed:
            raise ValueError('Duplicate sampled comparison key')
        indexed[token] = row
        values[token] = tuple(row[position] for position in positions)
    return indexed, values


def _select_union(sources, pools, keys, target, seed):
    candidates = {}
    for source, pool in zip(sources, pools):
        _, values = _index(pool, source, keys)
        for token, original in values.items():
            candidates.setdefault(token, original)
    # A semente só ordena candidatos já capturados, sem fingir reproduzir o sorteio SQL.
    ordered = sorted(candidates, key=lambda token: hashlib.sha256(
        (str(seed) + ':' + repr(token)).encode('utf-8')).digest())[:target]
    return ordered, [candidates[token] for token in ordered]


def schema_findings(sources):
    a, b = sources
    findings = []
    for name in sorted(a['names'].keys() | b['names'].keys()):
        an, bn = a['names'].get(name), b['names'].get(name)
        if an is None or bn is None:
            findings.append({'source': 2, 'column': name, 'kind': 'column_presence', 'reference': an, 'target': bn})
            continue
        left, right = a['columns'][an], b['columns'][bn]
        af, bf = _family(left), _family(right)
        equivalent_numeric = {af, bf} <= NUMERIC_FAMILIES
        if af != bf and not equivalent_numeric:
            findings.append({'source': 2, 'column': name, 'kind': 'type_family',
                             'reference': left['type'], 'target': right['type'], 'severity': 'difference'})
        elif left['type'].casefold() != right['type'].casefold():
            findings.append({'source': 2, 'column': name, 'kind': 'compatible_native_types',
                             'reference': left['type'], 'target': right['type'], 'severity': 'observation'})
        for attribute in ('nullable', 'primary_key', 'length', 'precision', 'scale'):
            if attribute in {'precision', 'scale'} and not (af == bf == 'decimal'):
                continue
            if attribute == 'precision' and left.get('precision_radix') != right.get('precision_radix'):
                continue
            if attribute == 'length' and not (af == bf == 'text'):
                continue
            av, bv = left.get(attribute), right.get(attribute)
            if av is not None and bv is not None and av != bv:
                findings.append({'source': 2, 'column': name, 'kind': attribute, 'reference': av, 'target': bv})
    return findings


def quality_findings(profiles):
    findings = []
    for index, profile in enumerate(profiles, 1):
        for name, metric in profile['metrics'].items():
            conditions = []
            if metric['sample_count'] and metric['null_count'] == metric['sample_count']:
                conditions.append(('all_null_in_sample', metric['null_count'], 'observation'))
            if metric.get('nullable') is False and metric['null_count']:
                conditions.append(('not_null_violation', metric['null_count'], 'violation'))
            for field in ('invalid_numeric_count', 'non_finite_count', 'blank_count', 'unavailable_count', 'unsupported_count'):
                if metric.get(field, 0):
                    conditions.append((field, metric[field], 'inconclusive' if field in {'unavailable_count', 'unsupported_count'} else 'observation'))
            findings.extend({'source': index, 'column': name, 'kind': kind, 'count': count, 'severity': severity}
                            for kind, count, severity in conditions)
        pk = profile['primary_key']
        if pk.get('sample_unique') is False:
            findings.append({'source': index, 'column': ', '.join(pk['columns']),
                             'kind': 'invalid_primary_key_in_sample', 'severity': 'violation',
                             'count': pk['duplicate_key_rows'] + pk['null_key_rows']})
    return findings


def value_distributions(sources, profiles):
    """Sobreposição observada sem persistir categorias ou afirmar igualdade."""
    results = []
    for name in sorted(sources[0]['names'].keys() & sources[1]['names'].keys()):
        counts = []
        for source, profile in zip(sources, profiles):
            actual = source['names'][name]
            index = profile['sample_columns'].index(actual)
            tokens = [value_token(row[index], source['columns'][actual]) for row in profile['sample_rows']]
            counts.append(Counter(token for token in tokens if token[0] not in {'null', 'unsupported', 'unavailable', 'nonfinite'}))
        results.append({'column': name, 'reference_observed': sum(counts[0].values()),
                        'target_observed': sum(counts[1].values()),
                        'common_occurrences': sum((counts[0] & counts[1]).values()),
                        'scope': 'descriptive observed multiset overlap; not record alignment'})
    return results


def _compare_rows(sources, profiles, keys, requested_tokens, abs_tol, rel_tol):
    a, b = sources
    left, _ = _index(profiles[0], a, keys)
    right, _ = _index(profiles[1], b, keys)
    universe = set(requested_tokens)
    if (left.keys() | right.keys()) - universe:
        raise ValueError('Lookup returned keys outside the sampled set (collation or conversion mismatch)')
    common = left.keys() & right.keys()
    incomparable_columns, positions = [], []
    for name in sorted(a['names'].keys() & b['names'].keys()):
        am, bm = a['columns'][a['names'][name]], b['columns'][b['names'][name]]
        families = {_family(am), _family(bm)}
        if len(families) > 1 and not (families <= NUMERIC_FAMILIES or families <= {'uuid', 'uniqueidentifier'}):
            incomparable_columns.append(name)
            continue
        positions.append((name, profiles[0]['sample_columns'].index(a['names'][name]),
                          profiles[1]['sample_columns'].index(b['names'][name]), am, bm))
    differences = Counter({name: 0 for name, *_ in positions})
    unknowns = Counter({name: 0 for name, *_ in positions})
    different_rows = 0
    for token in common:
        changed = False
        for name, i, j, am, bm in positions:
            equal = values_equal(left[token][i], right[token][j], am, bm,
                                 absolute_tolerance=abs_tol, relative_tolerance=rel_tol)
            if equal is None:
                unknowns[name] += 1
            elif not equal:
                differences[name] += 1
                changed = True
        different_rows += int(changed)
    missing_left = len(right.keys() - left.keys())
    missing_right = len(left.keys() - right.keys())
    vanished = len(universe - (left.keys() | right.keys()))
    unmatched = sorted(a['names'].keys() ^ b['names'].keys())
    status = 'compatible_in_sample'
    if not common or incomparable_columns or unmatched or sum(unknowns.values()) or vanished:
        status = 'inconclusive'
    if missing_left or missing_right or different_rows:
        status = 'difference_observed'
    result = {'source': 2, 'status': status, 'requested_keys': len(universe),
              'common_keys': len(common), 'matched_keys': len(common),
              'missing_in_reference': missing_left, 'missing_in_target': missing_right,
              'missing_keys': missing_right, 'unavailable_in_both': vanished,
              'different_rows': different_rows, 'different_values': dict(differences),
              'incomparable_values': dict(unknowns), 'incompatible_columns': incomparable_columns,
              'unmatched_columns': unmatched, 'compared_columns': [p[0] for p in positions],
              'scope': 'shared key sample collected from both tables; no population equality claim'}
    columns = a['names'].keys() | b['names'].keys()
    missing_positions = (missing_left + missing_right) * len(columns) + len(common) * len(unmatched)
    unknown_positions = (vanished * len(columns) + len(common) * len(incomparable_columns)
                         + sum(unknowns.values()))
    result['agreement'] = agreement_score(len(universe) * len(columns),
                                          sum(differences.values()), missing_positions, unknown_positions)
    common_profiles = [profile_rows(source['columns'], profile['sample_columns'],
                                   [index[token] for token in sorted(common, key=repr)],
                                   allow_ambiguous=source.get('explicit_options', False))
                       for source, profile, index in zip(sources, profiles, (left, right))]
    return result, common_profiles


def execute_comparison(selected, mode='auto', sample_size=None, prepared=None, options=None,
                       absolute_tolerance=Decimal('0'), relative_tolerance=Decimal('0'),
                       preview_callback=None, preview_limit=5, execution_id=None,
                       comparison_options=None, resolved_scope=None):
    started_at = datetime.now().astimezone().isoformat(timespec='microseconds')
    execution_id = str(execution_id or uuid4())
    if len(selected) != 2:
        raise ValueError('Select exactly two tables for a comparison')
    if mode not in {'auto', 'matched_keys', 'independent_random'}:
        raise ValueError('Unsupported comparison mode')
    if isinstance(preview_limit, bool) or not isinstance(preview_limit, int) or not 0 <= preview_limit <= 5:
        raise ValueError('preview_limit must be between 0 and 5')
    if preview_callback is not None and not callable(preview_callback):
        raise ValueError('preview_callback must be callable')
    options = options or SamplingOptions()
    if sample_size is not None and (isinstance(sample_size, bool) or not isinstance(sample_size, int)
                                   or not 1 <= sample_size <= options.max_rows):
        raise ValueError(f'sample_size must be between 1 and {options.max_rows}')
    abs_tol, rel_tol = Decimal(str(absolute_tolerance)), Decimal(str(relative_tolerance))
    if not abs_tol.is_finite() or not rel_tol.is_finite() or min(abs_tol, rel_tol) < 0:
        raise ValueError('Numeric tolerances must be finite nonnegative numbers')
    from ..comparison_options import compact_options, metadata_signature, validate_options
    from ..storage import DomainError
    configured = compact_options(comparison_options)
    has_databricks = any(s["creds"]["type"]=="databricks" for s in (prepared if prepared is not None else selected))
    sources = prepared if prepared is not None else prepare_sources(selected, explicit_options=bool(configured) or has_databricks)
    if len(sources) != 2:
        raise ValueError('Prepared sources must contain exactly two tables')
    context, key_validation = None, []
    if configured or has_databricks:
        for source in sources:
            expected = source.get('expected_columns')
            if expected is not None and metadata_signature(source['columns']) != expected:
                raise DomainError(409, 'source_schema_changed', 'Source metadata changed after enqueue; refresh the dataset and review the definition.')
        context = validate_options(configured, [s['columns'] for s in sources], mode, resolved_scope)
        for i, side in enumerate(('left', 'right')):
            names = {f'pair_{j}': pair[side] for j, pair in enumerate(context['mapping'])}
            names.update({f'unpaired_{side}_{j}': name for j, name in enumerate(context['unmatched_columns'][side])})
            sources[i].update(names=names, scope=context['predicates'][i], explicit_options=True)
            if sources[i]['scope']:
                sources[i]['estimated_rows'] = None
        business = context['business_key']
        if business:
            keys = [next(k for k, v in sources[0]['names'].items() if v == pair['left']) for pair in business]
            key_kind = 'business_key'
            for source in sources:
                physical = [source['names'][key] for key in keys]
                diagnostic = source['adapter'].validate_key(source['conn'], source['schema'], source['table'], physical, source['scope'])
                key_validation.append({**diagnostic, 'columns': physical,
                    'read_consistency': source.get('read_consistency', 'best_effort')})
        else:
            keys, key_kind = common_comparison_key(sources) if mode != 'independent_random' else ([], None)
    else:
        keys, key_kind = common_comparison_key(sources) if mode != 'independent_random' else ([], None)
    if has_databricks and keys and not key_validation:
        for source in sources:
            physical=[source['names'][key] for key in keys]
            diagnostic=source['adapter'].validate_key(source['conn'],source['schema'],source['table'],physical,source.get('scope'))
            key_validation.append({**diagnostic,'columns':physical,'read_consistency':source.get('read_consistency','best_effort')})
    invalid_business_key = bool(key_validation) and not all(v['valid'] for v in key_validation)
    if invalid_business_key:
        keys = []  # Keep the selected identity in context; never try another key.
    if mode == 'matched_keys' and not keys and not invalid_business_key:
        raise ValueError('Matched sampling requires compatible primary or non-null UNIQUE keys')
    actual_mode = 'matched_keys' if keys else 'key_validation_failed' if invalid_business_key else 'independent_random'
    warnings = []
    initial = pilot_size(sources, options, sample_size)
    pilots = [_capture(source, initial) for source in sources]
    if keys:
        try:
            for source, profile in zip(sources, pilots):
                _index(profile, source, keys)
        except ValueError:
            if key_kind == 'business_key' or has_databricks:
                invalid_business_key = True
                for validation in key_validation:
                    validation.update(valid=False, reason='key_unavailable_or_changed_after_validation')
                keys, actual_mode = [], 'key_validation_failed'
            else:
                if mode == 'matched_keys':
                    raise
                warnings.append('Invalid keys observed in pilot; falling back to independent profiles.')
                keys, key_kind, actual_mode = [], None, 'independent_random'
    plan = plan_sample(sources, pilots, options, actual_mode, keys, key_kind, sample_size)
    target = plan['target_rows']
    pools = []
    expanded = False
    for source, pilot in zip(sources, pilots):
        if target > initial and pilot['sample_size'] == initial:
            pools.append(_capture(source, target))
            expanded = True
        else:
            # O piloto completo de uma tabela pequena pode ser reutilizado.
            pools.append(pilot)
    if expanded:
        plan['rounds'].append({'stage': 'expanded', 'requested_rows_per_source': target,
                               'observed_rows': [p['sample_size'] for p in pools],
                               'note': 'fresh random draw; pilot rows are not appended'})
    if keys:
        try:
            tokens, key_values = _select_union(sources, pools, keys, target, plan['seed'])
        except ValueError:
            if key_kind == 'business_key' or has_databricks:
                invalid_business_key = True
                for validation in key_validation:
                    validation.update(valid=False, reason='key_unavailable_or_changed_after_validation')
            elif mode == 'matched_keys':
                raise
            keys = []
            if not invalid_business_key:
                plan.update(mode='independent_random', key_columns=[], key_kind=None,
                            selection='independent random samples after invalid-key fallback',
                            metric_scope='independent profiles; descriptive differences only')
                warnings.append('Invalid keys observed after expansion; falling back to independent profiles.')
    if keys:
        try:
            profiles = [fetch_by_keys(source, keys, key_values) for source in sources]
            row_result, metric_profiles = _compare_rows(sources, profiles, keys, tokens, abs_tol, rel_tol)
            row_results = [row_result]
            plan['selected_keys'] = len(tokens)
            plan['rounds'].append({'stage': 'common_key_lookup', 'requested_keys_per_source': len(tokens),
                                   'observed_rows': [p['sample_size'] for p in profiles]})
        except ValueError:
            if key_kind != 'business_key' and not has_databricks:
                raise
            invalid_business_key = True
            for validation in key_validation:
                validation.update(valid=False, reason='key_unavailable_or_changed_after_validation')
            keys = []
    if not keys:
        profiles = [profile_rows(source['columns'], pool['sample_columns'], pool['sample_rows'][:target],
                                 allow_ambiguous=source.get('explicit_options', False))
                    for source, pool in zip(sources, pools)]
        metric_profiles, row_results = profiles, []
    findings = schema_findings(sources)
    quality = quality_findings(profiles)
    if context:
        metrics = compare_profiles(*[{'metrics': {logical: profile['metrics'][physical]
            for logical, physical in source['names'].items()}} for source, profile in zip(sources, metric_profiles)])
        for finding in findings + metrics:
            logical = finding['column']
            finding.update(left_column=sources[0]['names'].get(logical), right_column=sources[1]['names'].get(logical))
            finding['column'] = finding['left_column'] or finding['right_column']
            if 'reference_column' in finding:
                finding.update(reference_column=finding['left_column'], target_column=finding['right_column'])
        for row in row_results:
            row['column_pairs'] = context['mapping']
            for field in ('different_values', 'incomparable_values'):
                row[field] = {sources[0]['names'].get(k, k): v for k, v in row[field].items()}
            for field in ('compared_columns', 'incompatible_columns', 'unmatched_columns'):
                row[field] = [sources[0]['names'].get(k) or sources[1]['names'].get(k) for k in row[field]]
        for finding in quality:
            side = 'left' if finding['source'] == 1 else 'right'
            pair = next((p for p in context['mapping'] if p[side] == finding['column']), None)
            finding.update(left_column=pair['left'] if pair else finding['column'] if side == 'left' else None,
                           right_column=pair['right'] if pair else finding['column'] if side == 'right' else None)
    else:
        metrics = compare_profiles(*metric_profiles)
    status = row_results[0]['status'] if row_results else 'profile_only'
    if any(p['sample_size'] == 0 for p in profiles) and status != 'difference_observed':
        status = 'inconclusive'
    schema_differences = [f for f in findings if f.get('severity') != 'observation']
    if schema_differences or any(f['severity'] == 'violation' for f in quality):
        status = 'difference_observed'
    elif any(f['severity'] == 'inconclusive' for f in quality) and status != 'difference_observed':
        status = 'inconclusive'
    if invalid_business_key:
        status = 'inconclusive'
        warnings.append('Business key is invalid or unavailable: nulls, duplicates, or a changed key after full-scope validation. Record agreement was not evaluated; no alternative key was selected.')
    if context:
        if any(_family(source['columns'][pair[side]]) == 'text' for source, side in zip(sources, ('left', 'right')) for pair in context['business_key']):
            warnings.append('Full-scope text-key grouping uses source equality semantics; case, accent or padding equivalence can conservatively invalidate a key. Record lookups and value comparisons remain exact.')
        for i, source in enumerate(sources, 1):
            if source.get('read_consistency') != 'stable_snapshot':
                warnings.append(f'Source {i}: stable read unavailable. Full-scope validation and sample reads can observe different states.')
    warnings.extend(['A sample cannot establish equality of entire tables.',
                     'No synchronized snapshot across databases; concurrent changes can affect results.',
                     'Random ordering may scan/sort the table; sample limits do not bound server work.',
                     'Catalog row counts are estimates and are not used as proof of missing data.'])
    if not keys:
        warnings.append('No row alignment: metric and observed-value differences are descriptive only.')
    if any(p['sample_size'] == 0 for p in profiles):
        warnings.append('Empty sample: data metrics unavailable; no equality conclusion.')
    plan.update(actual_rows=[p['sample_size'] for p in profiles],
                value_comparison={'absolute_tolerance': str(abs_tol), 'relative_tolerance': str(rel_tol),
                                  'strings': 'exact; whitespace and case preserved'})
    indicators = {'method_version': 1,
                  'agreement': row_results[0]['agreement'] if row_results else unaligned_agreement(),
                  'quality': combine_quality(profiles)}
    if preview_callback is not None and preview_limit:
        indexes = [_index(profile, source, keys)[0] for source, profile in zip(sources, profiles)] if keys else None
        preview_callback(build_preview(sources, profiles, limit=preview_limit, keys=keys,
            tokens=tokens if keys else (), key_values=key_values if keys else (), indexes=indexes,
            absolute_tolerance=abs_tol, relative_tolerance=rel_tol))
    public_sources = [{
        'connection': source['connection'], 'database_type': source['creds']['type'],
        'catalog_name': source.get('catalog_name',''), 'schema': source['schema'], 'table_name': source['table'],
        'table': ".".join(p for p in (source.get("catalog_name",""),source["schema"],source["table"]) if p),
        'estimated_rows': source['estimated_rows'],
        **{name: value for name, value in profile.items() if name not in {'sample_rows', 'sample_columns'}},
    } for source, profile in zip(sources, profiles)]
    finished_at = datetime.now().astimezone().isoformat(timespec='microseconds')
    result = {'format_version': 5 if context else 4, 'engine_version': '5.0' if context else '4.0', 'indicators': indicators,
            'execution_id': execution_id, 'started_at': started_at, 'finished_at': finished_at,
            'created_at': datetime.now().astimezone().isoformat(timespec='seconds'),
            'sample_size': target, 'sampling_plan': plan, 'sources': public_sources,
            'summary': {'status': status, 'schema_differences': len(schema_differences),
                        'quality_observations': len(quality), 'scope': 'sample'},
            'schema_findings': findings, 'quality_findings': quality,
            'row_comparisons': row_results, 'metric_comparisons': metrics,
            'value_distributions': value_distributions(sources, profiles) if not keys else [],
            'query_log': [{'source': index, **event} for index, source in enumerate(sources, 1)
                          for event in source.get('query_log', [])], 'warnings': warnings}
    if context:
        for distribution in result['value_distributions']:
            logical = distribution['column']
            distribution.update(column=sources[0]['names'][logical], left_column=sources[0]['names'][logical],
                                right_column=sources[1]['names'][logical])
        result.update(comparison_options=configured, resolved_scope=context['resolved_scope'],
            column_mapping=context['mapping'], unmatched_columns=context['unmatched_columns'],
            business_key=context['business_key'], key_validation=key_validation,
            read_consistency=[{'source': i, 'mode': s.get('read_consistency', 'best_effort')}
                              for i, s in enumerate(sources, 1)])
        plan['column_matching'] = 'explicit pairs followed by unambiguous name matching'
        plan['key_columns'] = [sources[0]['names'][k] for k in keys]
        if invalid_business_key:
            plan.update(mode='key_validation_failed', key_kind='business_key',
                        key_columns=[p['left'] for p in context['business_key']] or key_validation[0]['columns'],
                        metric_scope='descriptive profiles only; selected business key is invalid')
    return result
