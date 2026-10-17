"""Evidências temporárias enviadas por callback; não fazem parte do histórico."""

from datetime import date, datetime, time
from decimal import Decimal
from uuid import UUID

from .quality import NUMERIC_FAMILIES, UnavailableValue, metadata_family, values_equal


def _cell(source, profile, row, column):
    if row is None:
        return {'state': 'record_missing'}
    actual = source['names'].get(column)
    if actual is None:
        return {'state': 'column_missing'}
    value = row[profile['sample_columns'].index(actual)]
    if value is None:
        return {'state': 'null'}
    if isinstance(value, UnavailableValue):
        return {'state': 'unavailable', 'reason': value.reason}
    if not isinstance(value, (str, bytes, bytearray, memoryview, int, float, Decimal, bool,
                              date, datetime, time, UUID, dict, list, tuple)):
        return {'state': 'unavailable', 'reason': 'unsupported_value'}
    return {'state': 'value', 'value': value}


def build_preview(sources, profiles, *, limit, keys=(), tokens=(), key_values=(),
                  indexes=None, absolute_tolerance=Decimal(0), relative_tolerance=Decimal(0)):
    if not keys:
        return {'mode': 'independent_random', 'pairs': [], 'differences': [],
                'sources': [{'source': i, 'rows': [
                    {name: _cell(source, profile, row, name) for name in source['names']}
                    for row in profile['sample_rows'][:limit]]}
                    for i, (source, profile) in enumerate(zip(sources, profiles), 1)]}
    payload = {'mode': 'matched_keys', 'pairs': [], 'differences': [], 'sources': []}
    columns = sorted(sources[0]['names'].keys() | sources[1]['names'].keys())
    for token, key in zip(tokens, key_values):
        left, right = indexes[0].get(token), indexes[1].get(token)
        key_data = dict(zip(keys, key))
        if left is not None and right is not None and len(payload['pairs']) < limit:
            payload['pairs'].append({'key': key_data, 'cells': [
                {'column': name, 'reference': _cell(sources[0], profiles[0], left, name),
                 'target': _cell(sources[1], profiles[1], right, name)} for name in columns]})
        if len(payload['differences']) >= limit:
            if len(payload['pairs']) >= limit:
                break
            continue
        for name in columns:
            a, b = _cell(sources[0], profiles[0], left, name), _cell(sources[1], profiles[1], right, name)
            states = {a['state'], b['state']}
            if 'record_missing' in states:
                reason = 'registro_ausente' if left is not None or right is not None else 'registro_indisponivel_nas_duas'
            elif 'column_missing' in states:
                reason = 'coluna_ausente'
            elif 'unavailable' in states:
                reason = 'valor_indisponivel'
            else:
                am, bm = (source['columns'][source['names'][name]] for source in sources)
                families = {metadata_family(am), metadata_family(bm)}
                if len(families) > 1 and not families <= NUMERIC_FAMILIES:
                    reason = 'tipos_incompativeis'
                else:
                    equal = values_equal(a.get('value'), b.get('value'), am, bm,
                                         absolute_tolerance=absolute_tolerance, relative_tolerance=relative_tolerance)
                    if equal is True:
                        continue
                    reason = 'valor_nao_comparavel' if equal is None else 'valor_diferente'
            payload['differences'].append({'key': key_data, 'column': name,
                                           'reference': a, 'target': b, 'reason': reason})
            if len(payload['differences']) == limit:
                break
    return payload
