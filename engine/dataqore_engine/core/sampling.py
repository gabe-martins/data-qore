"""Reproducible bottom-k selection over the union of typed source keys."""

from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, localcontext, MAX_EMAX, MIN_EMIN
import hashlib
import heapq
import json
import sys
from uuid import UUID
from .quality import value_token, metadata_family
from ..storage import DomainError


def size_bytes(value):
    if isinstance(value, (list, tuple)):
        return sys.getsizeof(value) + sum(size_bytes(v) for v in value)
    if isinstance(value, dict):
        return sys.getsizeof(value) + sum(
            size_bytes(k) + size_bytes(v) for k, v in value.items()
        )
    return sys.getsizeof(value)


@dataclass(frozen=True)
class SamplingOptions:
    method: str = "rows"
    rows: int = 1000
    percentage: str | None = None
    seed: int | None = None
    max_cells: int = 100000
    max_sample_bytes: int = 16777216

    def __post_init__(self):
        if self.method not in {"rows", "percentage"}:
            raise ValueError("Invalid sampling method")
        if (
            isinstance(self.rows, bool)
            or not isinstance(self.rows, int)
            or not 1 <= self.rows <= 10000
        ):
            raise ValueError("Rows must be between 1 and 10000")
        if isinstance(self.seed, str):
            if not self.seed.isascii() or not self.seed.isdigit():
                raise ValueError("Invalid seed")
            object.__setattr__(self, "seed", int(self.seed))
        if self.seed is not None and (
            isinstance(self.seed, bool)
            or not isinstance(self.seed, int)
            or not 0 <= self.seed < 2**64
        ):
            raise ValueError("Invalid seed")
        if self.method == "percentage":
            p = Decimal(str(self.percentage))
            if not p.is_finite() or not 0 < p <= 100:
                raise ValueError("Percentage must be greater than zero and at most 100")
        elif self.percentage is not None:
            raise ValueError("Percentage is only used with percentage sampling")
        for v in (self.max_cells, self.max_sample_bytes):
            if isinstance(v, bool) or not isinstance(v, int) or v < 1:
                raise ValueError("Budgets must be positive integers")

    def target(self, counts, width):
        k = self.rows
        if self.method == "percentage":
            percentage = Decimal(str(self.percentage))
            with localcontext() as context:
                context.prec = max(
                    40, len(percentage.as_tuple().digits) + len(str(max(counts))) + 3
                )
                context.Emax = MAX_EMAX
                context.Emin = MIN_EMIN
                k = int(
                    (percentage * max(counts) / 100).to_integral_value(
                        rounding=ROUND_CEILING
                    )
                )
        if k > 10000:
            raise DomainError(
                422,
                "sample_limit_exceeded",
                "Requested sample exceeds 10000 keys; reduce rows or percentage.",
            )
        if min(k, sum(counts)) * width * 2 > self.max_cells:
            raise DomainError(
                422,
                "sample_cell_budget_exceeded",
                "Requested sample exceeds the cell budget; reduce the sample or increase the budget.",
            )
        return k


def canonical_key(values, metadata):
    parts = []
    for value, info in zip(values, metadata):
        family = metadata_family(info)
        if family in {"integer", "decimal"}:
            token = value_token(value, info)
            if token[0] != "number":
                raise ValueError("Unavailable key")
            number = token[1]
            # Strip coefficient zeros without Decimal.normalize's context rounding.
            sign, digits, exponent = number.as_tuple()
            digits = list(digits)
            if not any(digits):
                sign, digits, exponent = 0, [0], 0
            else:
                while digits[-1] == 0:
                    digits.pop()
                    exponent += 1
            parts.append(["number", sign, "".join(map(str, digits)), exponent])
        elif family == "text" and isinstance(value, str):
            parts.append(["text", value])
        elif family == "binary" and isinstance(value, (bytes, bytearray, memoryview)):
            parts.append(["binary", bytes(value).hex()])
        elif family in {"uuid", "uniqueidentifier"}:
            try:
                parts.append(["uuid", str(UUID(str(value)))])
            except (ValueError, TypeError, AttributeError):
                raise ValueError("Unavailable key") from None
        else:
            raise ValueError("Unavailable key")
    return json.dumps(parts, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def select_keys(sources, key_columns, target, seed, byte_budget):
    if not target:
        return [], [0, 0]
    heap = []
    selected = {}
    scanned = []
    used = 0
    for source, names in zip(sources, key_columns):
        count = 0
        infos = [source["columns"][name] for name in names]
        for values in source["adapter"].iter_keys(
            source["conn"],
            source["schema"],
            source["table"],
            names,
            source["columns"],
            source["scope"],
        ):
            count += 1
            token = canonical_key(values, infos)
            rank = (
                int.from_bytes(
                    hashlib.sha256(str(seed).encode() + b":" + token).digest(), "big"
                ),
                token,
            )
            if token in selected:
                continue
            if len(selected) == target and rank >= (-heap[0][0], heap[0][1]):
                continue
            if len(selected) == target:
                _, old = heapq.heappop(heap)
                used -= size_bytes(selected.pop(old)) + len(old)
            values = tuple(values)
            used += size_bytes(values) + len(token)
            if used > byte_budget:
                raise DomainError(
                    422,
                    "sample_byte_budget_exceeded",
                    "Selected keys exceed the byte budget; reduce the sample.",
                )
            selected[token] = values
            heapq.heappush(heap, (-rank[0], token))
        scanned.append(count)
    return [
        (token, selected[token]) for _, token in sorted([(-h, t) for h, t in heap])
    ], scanned
