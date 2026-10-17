"""Indicadores amostrais auditáveis; sem valores brutos no resultado."""

from collections import Counter
from decimal import Decimal, localcontext

from .quality import (NUMERIC_FAMILIES, UnavailableValue, metadata_family,
                     value_token)


def score(passed, evaluated, total):
    if not 0 <= passed <= evaluated <= total:
        raise ValueError('Invalid indicator counts')
    with localcontext() as context:
        context.prec = 40
        percentage = (Decimal(100) * passed / evaluated).quantize(Decimal('.0001')) if evaluated else None
        coverage = (Decimal(100) * evaluated / total).quantize(Decimal('.0001')) if total else None
    return {'passed': passed, 'evaluated': evaluated, 'total': total,
            'failed': evaluated - passed, 'pending': total - evaluated,
            'percentage': percentage, 'coverage_percentage': coverage,
            'status': 'not_evaluated' if not evaluated else 'partial' if evaluated < total else 'complete'}


def agreement_score(total, different, missing, unknown):
    result = score(total - different - missing - unknown, total - unknown, total)
    result.update(equal_cells=result['passed'], different_cells=different,
                  missing_positions=missing, unknown_cells=unknown,
                  scope='sampled key/column positions',
                  formula='100 * equal_cells / evaluated_positions')
    return result


def unaligned_agreement():
    result = score(0, 0, 0)
    result.update(reason='no_safe_key_alignment', scope='sample',
                  formula='100 * equal_cells / evaluated_positions')
    return result


def _type_validity(value, info):
    """True/False para tipos conhecidos, None quando não é possível avaliar."""
    if isinstance(value, UnavailableValue):
        return None
    family = metadata_family(info)
    token = value_token(value, info)
    if token[0] == 'unavailable':
        return None
    if family in NUMERIC_FAMILIES:
        if token[0] == 'nonfinite':
            return True  # A regra separada de finitude reprova o valor.
        if token[0] != 'number':
            return False if token == ('unsupported', 'invalid_numeric') else None
        return family != 'integer' or token[1] == token[1].to_integral_value()
    if family == 'text':
        return isinstance(value, str)
    if family == 'binary':
        return isinstance(value, (bytes, bytearray, memoryview))
    expected = {'boolean': 'boolean', 'date': 'date', 'datetime': 'datetime',
                'time': 'time', 'uuid': 'uuid', 'json': ('dict', 'sequence', 'text', 'number', 'boolean', 'null'),
                'array': 'sequence'}
    if family not in expected:
        return None
    if token[0] == 'unsupported':
        return False if str(token[1]).startswith('invalid_') else None
    allowed = expected[family]
    return token[0] in allowed if isinstance(allowed, tuple) else token[0] == allowed


def quality_assessment(profile):
    rules = {name: [0, 0, 0] for name in ('required_fields', 'type_validity', 'finite_numbers', 'key_integrity')}

    def add(rule, outcome):
        counts = rules[rule]
        counts[2] += 1
        if outcome is not None:
            counts[1] += 1
            counts[0] += int(outcome)

    names, rows, metadata = profile['sample_columns'], profile['sample_rows'], profile['columns']
    for index, name in enumerate(names):
        info = metadata[name]
        family = metadata_family(info)
        for row in rows:
            value = row[index]
            unknown = isinstance(value, UnavailableValue)
            if info.get('nullable') is False:
                add('required_fields', None if unknown else value is not None)
            if value is None:
                continue  # NULL permitido não gera penalidade nem aprovação artificial de tipo.
            validity = _type_validity(value, info)
            add('type_validity', validity)
            if family in NUMERIC_FAMILIES:
                token = value_token(value, info)
                if token[0] in {'number', 'nonfinite'}:
                    add('finite_numbers', token[0] == 'number')
                elif validity is None:
                    add('finite_numbers', None)

    groups = []
    primary = [name for name, info in metadata.items() if info.get('primary_key')]
    if primary:
        groups.append(tuple(sorted(primary)))
    unique = {}
    for name, info in metadata.items():
        for group in info.get('unique_groups', []):
            unique.setdefault(group, []).append(name)
    for group in unique.values():
        if all(metadata[name].get('nullable') is False for name in group):
            groups.append(tuple(sorted(group)))
    # O mesmo conjunto pode aparecer como PK e índice UNIQUE: avaliar uma vez.
    for group in sorted(set(groups)):
        tokens = []
        for row in rows:
            values = [row[names.index(name)] for name in group]
            if any(value is None for value in values):
                tokens.append(('invalid', None))
                continue
            parts = tuple(value_token(value, metadata[name]) for name, value in zip(group, values))
            if any(part[0] in {'unavailable', 'unsupported'} for part in parts):
                tokens.append(('unknown', None))
            elif any(part[0] == 'nonfinite' for part in parts):
                tokens.append(('invalid', None))
            else:
                tokens.append(('value', parts))
        counts = Counter(value for state, value in tokens if state == 'value')
        for state, value in tokens:
            add('key_integrity', None if state == 'unknown' else state == 'value' and counts[value] == 1)

    result = score(*(sum(counts[i] for counts in rules.values()) for i in range(3)))
    result.update(rules={name: score(*counts) for name, counts in rules.items()},
                  scope='observed sample rules; not whole-table or business correctness',
                  formula='100 * passed_checks / evaluated_checks')
    return result


def combine_quality(profiles):
    sources = [{'source': index, **quality_assessment(profile)} for index, profile in enumerate(profiles, 1)]
    overall = score(*(sum(source[field] for source in sources) for field in ('passed', 'evaluated', 'total')))
    overall.update(formula='100 * sum(passed_checks) / sum(evaluated_checks)', scope='sample')
    return {'sources': sources, 'overall': overall,
            'criteria': ['required_fields', 'type_validity', 'finite_numbers', 'key_integrity'],
            'nullable_nulls': 'not_penalized', 'blank_strings': 'observation_only'}


def audit_indicators(indicators):
    """Recalcula fórmulas sobre contagens agregadas, inclusive após YAML/JSON."""
    issues = []

    def check(indicator, label):
        try:
            counts = [indicator[field] for field in ('passed', 'evaluated', 'total')]
            if any(isinstance(v, bool) or not isinstance(v, int) for v in counts):
                raise ValueError
            expected = score(*counts)
            for field in ('failed', 'pending', 'status', 'percentage', 'coverage_percentage'):
                value = indicator.get(field)
                if field in {'percentage', 'coverage_percentage'} and value is not None:
                    value = Decimal(str(value))
                    if not value.is_finite():
                        raise ValueError
                if value != expected[field]:
                    raise ValueError
        except (ValueError, TypeError, KeyError, ArithmeticError):
            issues.append(f'{label}: inconsistent indicator counts or percentages')

    try:
        check(indicators['agreement'], 'agreement')
        quality = indicators['quality']
        check(quality['overall'], 'quality overall')
        for source in quality['sources']:
            check(source, f"quality source {source.get('source')}")
            for rule, indicator in source['rules'].items():
                check(indicator, f"quality rule {rule}")
            if any(source[field] != sum(r[field] for r in source['rules'].values())
                   for field in ('passed', 'evaluated', 'total')):
                issues.append('quality source: rule counts do not reconcile')
        if any(quality['overall'][field] != sum(s[field] for s in quality['sources'])
               for field in ('passed', 'evaluated', 'total')):
            issues.append('quality overall: source counts do not reconcile')
    except (KeyError, TypeError, AttributeError, ValueError):
        issues.append('indicators: incomplete structure')
    return issues
