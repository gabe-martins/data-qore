import type { Model } from "../api";
import { Button, Card } from "./common";

export type ComparisonOptions = Model<"ComparisonOptions">;
type Pair = { left: string; right: string };
type Columns = Record<string, { type?: string; family?: string }>;
type Props = {
  value: ComparisonOptions;
  onChange: (v: ComparisonOptions) => void;
  left: Columns;
  right: Columns;
};
const sides = ["left", "right"] as const;
function ColumnSelect({
  label,
  columns,
  value,
  onChange,
}: {
  label: string;
  columns: Columns;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        required
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose column</option>
        {Object.entries(columns).map(([name, info]) => (
          <option key={name} value={name}>
            {name} · {info.type}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ScopeEditor({ value, onChange, left, right }: Props) {
  const scope = value.scope ?? {};
  const period = scope.period;
  const filters = scope.filters ?? [];
  const update = (next: typeof scope) =>
    onChange({
      ...value,
      scope: next.period || next.filters?.length ? next : undefined,
    });
  const changePeriod = (patch: Partial<NonNullable<typeof period>>) =>
    update({ ...scope, period: { ...period!, ...patch } });
  return (
    <Card
      title="Equivalent scope"
      subtitle="One logical period and set of criteria, applied to both sources with AND. No SQL input."
    >
      <label>
        Period
        <select
          aria-label="Period"
          value={period?.kind ?? "none"}
          onChange={(e) =>
            update({
              ...scope,
              period:
                e.target.value === "none"
                  ? undefined
                  : {
                      kind: e.target.value as "fixed" | "relative",
                      left: "",
                      right: "",
                      timezone: "America/Sao_Paulo",
                      unit: "days",
                      quantity: 1,
                      safety_delay_minutes: 0,
                      ...(e.target.value === "fixed"
                        ? { start: "", end: "" }
                        : {}),
                    },
            })
          }
        >
          <option value="none">All available dates</option>
          <option value="fixed">Fixed period</option>
          <option value="relative">Previous complete units</option>
        </select>
      </label>
      {period && (
        <>
          <div className="form-grid">
            <ColumnSelect
              label="Period column A"
              columns={Object.fromEntries(
                Object.entries(left).filter(([, v]) =>
                  /date|time/i.test(v.type ?? ""),
                ),
              )}
              value={period.left}
              onChange={(v) => changePeriod({ left: v })}
            />
            <ColumnSelect
              label="Period column B"
              columns={Object.fromEntries(
                Object.entries(right).filter(([, v]) =>
                  /date|time/i.test(v.type ?? ""),
                ),
              )}
              value={period.right}
              onChange={(v) => changePeriod({ right: v })}
            />
          </div>
          <div className="form-grid">
            <label>
              Scope timezone (IANA)
              <input
                aria-label="Scope timezone"
                required
                value={period.timezone ?? "America/Sao_Paulo"}
                onChange={(e) => changePeriod({ timezone: e.target.value })}
              />
            </label>
            {period.kind === "relative" ? (
              <>
                <label>
                  Unit
                  <select
                    aria-label="Period unit"
                    value={period.unit ?? "days"}
                    onChange={(e) =>
                      changePeriod({
                        unit: e.target.value as "hours" | "days" | "months",
                      })
                    }
                  >
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                    <option value="months">Months</option>
                  </select>
                </label>
                <label>
                  Complete units
                  <input
                    aria-label="Complete units"
                    type="number"
                    required
                    min={1}
                    max={100000}
                    value={period.quantity ?? 1}
                    onChange={(e) =>
                      changePeriod({ quantity: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Safety delay (minutes)
                  <input
                    aria-label="Safety delay (minutes)"
                    type="number"
                    required
                    min={0}
                    max={525600}
                    value={period.safety_delay_minutes ?? 0}
                    onChange={(e) =>
                      changePeriod({
                        safety_delay_minutes: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Start (inclusive)
                  <input
                    aria-label="Start (inclusive)"
                    type="text"
                    placeholder="YYYY-MM-DD or timestamp with offset"
                    required
                    value={period.start ?? ""}
                    onChange={(e) => changePeriod({ start: e.target.value })}
                  />
                </label>
                <label>
                  End (exclusive)
                  <input
                    aria-label="End (exclusive)"
                    type="text"
                    placeholder="YYYY-MM-DD or timestamp with offset"
                    required
                    value={period.end ?? ""}
                    onChange={(e) => changePeriod({ end: e.target.value })}
                  />
                </label>
              </>
            )}
          </div>
          <div className="form-grid">
            {sides.map((side, i) => (
              <label key={side}>
                Naive timestamp timezone {i ? "B" : "A"}
                <input
                  aria-label={`Naive timestamp timezone ${i ? "B" : "A"}`}
                  placeholder="Required for timestamps without timezone"
                  value={period[`${side}_naive_timezone`] ?? ""}
                  onChange={(e) =>
                    changePeriod({
                      [`${side}_naive_timezone`]: e.target.value || null,
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="notice">
            The end is exclusive. Relative windows use complete hours, calendar
            days or calendar months in the chosen timezone, after subtracting
            the safety delay. A preview is provisional; execution freezes the
            window when queued. Explicit timezone interpretation is required for
            timestamps without a timezone.
          </p>
        </>
      )}
      <h3>Equivalent filters / batches</h3>
      {filters.map((filter, index) => {
        function change(patch: Partial<typeof filter>) {
          update({
            ...scope,
            filters: filters.map((f, i) =>
              i === index ? { ...f, ...patch } : f,
            ),
          });
        }
        const isNull =
          filter.operator === "is_null" || filter.operator === "is_not_null";
        return (
          <fieldset className="scope-filter" key={index}>
            <legend>Criterion {index + 1}</legend>
            <div className="form-grid">
              <ColumnSelect
                label={`Filter ${index + 1} column A`}
                columns={left}
                value={filter.left}
                onChange={(v) => change({ left: v })}
              />
              <ColumnSelect
                label={`Filter ${index + 1} column B`}
                columns={right}
                value={filter.right}
                onChange={(v) => change({ right: v })}
              />
              <label>
                Operator
                <select
                  aria-label={`Filter ${index + 1} operator`}
                  value={filter.operator}
                  onChange={(e) =>
                    change({
                      operator: e.target.value as typeof filter.operator,
                      value:
                        e.target.value === "in"
                          ? [""]
                          : ["is_null", "is_not_null"].includes(e.target.value)
                            ? null
                            : "",
                    })
                  }
                >
                  {[
                    ["eq", "Equals"],
                    ["in", "In a list"],
                    ["gte", "Greater than or equal"],
                    ["lt", "Less than"],
                    ["is_null", "Is null"],
                    ["is_not_null", "Is not null"],
                  ].map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!isNull && (
              <label>
                {filter.operator === "in" ? "Values (one per line)" : "Value"}
                <textarea
                  aria-label={`Filter ${index + 1} value`}
                  required
                  value={
                    Array.isArray(filter.value)
                      ? filter.value.join("\n")
                      : String(filter.value ?? "")
                  }
                  onChange={(e) => {
                    const boolean = /^(boolean|bool|bit)$/i.test(
                      left[filter.left]?.type ?? "",
                    );
                    const scalar = (text: string) =>
                      boolean && ["true", "false"].includes(text)
                        ? text === "true"
                        : text;
                    change({
                      value:
                        filter.operator === "in"
                          ? e.target.value.split("\n").map(scalar)
                          : scalar(e.target.value),
                    });
                  }}
                />
              </label>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                update({
                  ...scope,
                  filters: filters.filter((_, i) => i !== index),
                })
              }
            >
              Remove criterion {index + 1}
            </Button>
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        disabled={filters.length >= 20}
        onClick={() =>
          update({
            ...scope,
            filters: [
              ...filters,
              { left: "", right: "", operator: "eq", value: "" },
            ],
          })
        }
      >
        Add filter / batch
      </Button>
      <p className="muted small">
        Use equality or a list for a batch. Decimal values use a dot and retain
        their precision. Only compatible column types are accepted; no value
        normalization or implicit type conversion.
      </p>
    </Card>
  );
}

export function suggestedPairs(
  left: Columns,
  right: Columns,
  manual: Pair[],
): Pair[] {
  const usedLeft = new Set(manual.map((p) => p.left)),
    usedRight = new Set(manual.map((p) => p.right));
  const pairs = [...manual];
  for (const name of Object.keys(left)) {
    const key = name.toLowerCase();
    const candidates = Object.keys(right).filter(
      (r) => !usedRight.has(r) && r.toLowerCase() === key,
    );
    if (
      !usedLeft.has(name) &&
      Object.keys(left).filter(
        (l) => !usedLeft.has(l) && l.toLowerCase() === key,
      ).length === 1 &&
      candidates.length === 1
    ) {
      pairs.push({ left: name, right: candidates[0] });
      usedLeft.add(name);
      usedRight.add(candidates[0]);
    }
  }
  return pairs;
}

export function MappingEditor({ value, onChange, left, right }: Props) {
  const manual = value.mapping ?? [],
    keys = value.business_key ?? [];
  const effective = suggestedPairs(left, right, manual);
  const keyFor = (pair: Pair) =>
    keys.some((k) => k.left === pair.left && k.right === pair.right);
  return (
    <Card
      title="Column mapping & identity"
      subtitle="Manual pairs take precedence; remaining unambiguous names match automatically."
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Source column A</th>
              <th>Comparison column B</th>
              <th>Business key</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(left).map(([name, info]) => {
              const selected = manual.find((p) => p.left === name),
                pair = effective.find((p) => p.left === name);
              return (
                <tr key={name}>
                  <td>
                    {name}
                    <small className="muted"> · {info.type}</small>
                  </td>
                  <td>
                    <select
                      aria-label={`Map ${name}`}
                      value={selected?.right ?? ""}
                      onChange={(e) => {
                        const mapping = manual.filter((p) => p.left !== name);
                        if (e.target.value)
                          mapping.push({ left: name, right: e.target.value });
                        const nextPairs = suggestedPairs(left, right, mapping);
                        onChange({
                          ...value,
                          mapping,
                          business_key: keys.filter((k) =>
                            nextPairs.some(
                              (p) => p.left === k.left && p.right === k.right,
                            ),
                          ),
                        });
                      }}
                    >
                      <option value="">
                        {pair && !selected
                          ? `Auto → ${pair.right}`
                          : "Auto / no matching name"}
                      </option>
                      {Object.entries(right).map(([target, targetInfo]) => (
                        <option
                          key={target}
                          value={target}
                          disabled={manual.some(
                            (p) => p.left !== name && p.right === target,
                          )}
                        >
                          {target} · {targetInfo.type}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`Business key ${name}`}
                      type="checkbox"
                      disabled={!pair}
                      checked={!!pair && keyFor(pair)}
                      onChange={(e) =>
                        pair &&
                        onChange({
                          ...value,
                          business_key: e.target.checked
                            ? [...keys, pair]
                            : keys.filter((k) => k.left !== name),
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="notice">
        Select one or more mapped pairs for a business key. Nulls and duplicates
        are checked across the entire scope on both sources during execution.
        Invalid keys prevent record alignment and are reported explicitly. With
        no selection, compatible PK / non-null UNIQUE keys are discovered
        automatically.
      </p>
      <p className="muted small">
        Mapping preserves original values and native type differences. Columns
        without a pair prevent a complete Row Match Rate evaluation. The preview
        uses current metadata and is authoritative for matching.
      </p>
    </Card>
  );
}
