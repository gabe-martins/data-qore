"""Planejamento amostral adaptativo compartilhado pelas duas fontes."""

from dataclasses import dataclass
from decimal import Decimal
import math
import secrets
import sys


@dataclass(frozen=True)
class SamplingOptions:
    pilot_rows: int = 64
    min_rows: int = 64
    max_rows: int = 1000
    max_cells: int = 100000
    max_sample_bytes: int = 16 * 1024 * 1024
    proportion_margin: float = 0.05
    seed: int | None = None

    def __post_init__(self):
        for field in ("pilot_rows", "min_rows", "max_rows", "max_cells", "max_sample_bytes"):
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{field} must be a positive integer")
        if self.max_rows > 10000:
            raise ValueError("max_rows cannot exceed 10000")
        if self.seed is not None and (isinstance(self.seed, bool) or not isinstance(self.seed, int)):
            raise ValueError("seed must be an integer")
        if not math.isfinite(self.proportion_margin) or not 0 < self.proportion_margin < 1:
            raise ValueError("proportion_margin must be between 0 and 1")


def row_capacity(sources, options):
    width = max(len(source["columns"]) for source in sources)
    if width > options.max_cells:
        raise ValueError("Cell budget cannot hold even one projected row")
    return max(1, min(options.max_rows, options.max_cells // max(1, width)))


def pilot_size(sources, options, requested=None):
    return min(options.pilot_rows, row_capacity(sources, options),
               requested if requested is not None else options.max_rows)


def _value_bytes(value):
    if isinstance(value, (tuple, list)):
        return sys.getsizeof(value) + sum(_value_bytes(v) for v in value)
    if isinstance(value, dict):
        return sys.getsizeof(value) + sum(_value_bytes(k) + _value_bytes(v) for k, v in value.items())
    return sys.getsizeof(value)


def plan_sample(sources, pilots, options, mode, keys, key_kind, requested=None):
    capacity = row_capacity(sources, options)
    initial = pilot_size(sources, options, requested)
    avg_bytes = max((sum(_value_bytes(row) for row in p["sample_rows"]) / p["sample_size"]
                     for p in pilots if p["sample_size"]), default=1)
    byte_capacity = max(1, int(options.max_sample_bytes / max(1, avg_bytes)))
    capacity = min(capacity, byte_capacity)
    estimates = [s["estimated_rows"] for s in sources if s["estimated_rows"] is not None and s["estimated_rows"] > 0]
    reasons = []
    all_exhausted = all(p["sample_size"] < initial for p in pilots)
    if requested is not None:
        desired = requested
        reasons.append("explicit row budget")
    elif all_exhausted:
        # Ambos os sorteios esgotaram os registros no momento de cada consulta.
        desired = max(1, sum(p["sample_size"] for p in pilots))
        reasons.append("both pilot reads exhausted their tables")
    else:
        volume = math.ceil(10 * math.sqrt(max(estimates))) if estimates else options.min_rows
        # Referência de planejamento para uma proporção: pior variância p(1-p)=.25.
        # Não é intervalo de confiança do resultado nem regra de parada inferencial.
        proportion = math.ceil(1.96 ** 2 * 0.25 / options.proportion_margin ** 2)
        variability = options.min_rows
        for profile in pilots:
            for name, metric in profile["metrics"].items():
                if name.casefold() in keys or not metric.get("numeric_count"):
                    continue
                mean, stddev = metric.get("mean"), metric.get("stddev")
                if mean is not None and stddev is not None:
                    cv = min(Decimal(10), abs(stddev) / max(abs(mean), Decimal("0.000001")))
                    variability = max(variability, math.ceil(options.min_rows * (1 + float(cv))))
        desired = max(options.min_rows, volume, proportion, variability)
        reasons.append("population estimates, proportion planning target and pilot numeric variability")
    target = max(1, min(desired, capacity))
    if target < desired:
        reasons.append("limited by row/cell budget or pilot byte estimate")
    return {
        "plan_version": 2, "mode": mode, "key_kind": key_kind,
        "key_columns": keys, "target_rows": target, "requested_rows": requested,
        "uncapped_target_rows": desired, "pilot_rows": initial,
        "pilot_observed_rows": [p["sample_size"] for p in pilots],
        "max_rows": options.max_rows, "width_limit": row_capacity(sources, options),
        "estimated_byte_limit_rows": byte_capacity, "max_sample_bytes": options.max_sample_bytes,
        "byte_budget_scope": "planning estimate from pilot; not a hard transport or process memory limit",
        "max_cells": options.max_cells, "proportion_planning_margin": options.proportion_margin,
        "strategy_reason": "; ".join(reasons),
        "seed": options.seed if options.seed is not None else secrets.randbits(64),
        "selection": "random pools from both sources; shared key union" if keys else "independent random samples",
        "repeatable_across_runs": False,
        "seed_scope": "shared-key selection within captured pools; database random draws are not repeatable",
        "metric_scope": "common matched rows" if keys else "independent profiles; descriptive differences only",
        "column_matching": "unambiguous casefold",
        "rounds": [{"stage": "pilot", "requested_rows_per_source": initial,
                    "observed_rows": [p["sample_size"] for p in pilots]}],
    }
