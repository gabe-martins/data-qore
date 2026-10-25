import { useLanguage } from "../i18n/LanguageProvider";
import type { Model } from "../api";
import { Button, Card } from "./common";

export type ComparisonOptions = Model<"ComparisonOptions">;
type Pair = { left: string; right: string };
type Columns = Record<
  string,
  {
    type?: string;
    family?: string;
    primary_key?: boolean;
    timestamp_kind?: string;
    comparison_timezone?: string;
  }
>;
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
  const { t: tr } = useLanguage();
  return (
    <label>
      {tr(label)}
      <select
        required
        aria-label={tr(label)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{tr("Choose column")}</option>
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
  const { t: tr } = useLanguage();
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
      title={tr("Equivalent scope")}
      subtitle={tr("One logical period and set of criteria, applied to both sources with AND. No SQL input.")}
    >
      <label>{tr("Period")}<select
          aria-label={tr("Period")}
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
          <option value="none">{tr("All available dates")}</option>
          <option value="fixed">{tr("Fixed period")}</option>
          <option value="relative">{tr("Previous complete units")}</option>
        </select>
      </label>
      {period && (
        <>
          <div className="form-grid">
            <ColumnSelect
              label={tr("Period column A")}
              columns={Object.fromEntries(
                Object.entries(left).filter(([, v]) =>
                  /date|time/i.test(v.type ?? ""),
                ),
              )}
              value={period.left}
              onChange={(v) => changePeriod({ left: v })}
            />
            <ColumnSelect
              label={tr("Period column B")}
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
            <label>{tr("Scope timezone (IANA)")}<input
                aria-label={tr("Scope timezone")}
                required
                value={period.timezone ?? "America/Sao_Paulo"}
                onChange={(e) => changePeriod({ timezone: e.target.value })}
              />
            </label>
            {period.kind === "relative" ? (
              <>
                <label>{tr("Unit")}<select
                    aria-label={tr("Period unit")}
                    value={period.unit ?? "days"}
                    onChange={(e) =>
                      changePeriod({
                        unit: e.target.value as "hours" | "days" | "months",
                      })
                    }
                  >
                    <option value="hours">{tr("Hours")}</option>
                    <option value="days">{tr("Days")}</option>
                    <option value="months">{tr("Months")}</option>
                  </select>
                </label>
                <label>{tr("Complete units")}<input
                    aria-label={tr("Complete units")}
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
                <label>{tr("Safety delay (minutes)")}<input
                    aria-label={tr("Safety delay (minutes)")}
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
                <label>{tr("Start (inclusive)")}<input
                    aria-label={tr("Start (inclusive)")}
                    type="text"
                    placeholder={tr("YYYY-MM-DD or timestamp with offset")}
                    required
                    value={period.start ?? ""}
                    onChange={(e) => changePeriod({ start: e.target.value })}
                  />
                </label>
                <label>{tr("End (exclusive)")}<input
                    aria-label={tr("End (exclusive)")}
                    type="text"
                    placeholder={tr("YYYY-MM-DD or timestamp with offset")}
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
              <label key={side}>{tr("Naive timestamp timezone ")}{i ? "B" : "A"}
                <input
                  aria-label={tr("Naive timestamp timezone {0}", {0: i ? "B" : "A"})}
                  placeholder={tr("Required for timestamps without timezone")}
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
          <p className="notice">{tr("The end is exclusive. Relative windows use complete hours, calendar days or calendar months in the chosen timezone, after subtracting the safety delay. A preview is provisional; execution freezes the window when queued. Explicit timezone interpretation is required for timestamps without a timezone.")}</p>
        </>
      )}
      <h3>{tr("Equivalent filters / batches")}</h3>
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
            <legend>{tr("Criterion ")}{index + 1}</legend>
            <div className="form-grid">
              <ColumnSelect
                label={tr("Filter {0} column A", {0: index + 1})}
                columns={left}
                value={filter.left}
                onChange={(v) => change({ left: v })}
              />
              <ColumnSelect
                label={tr("Filter {0} column B", {0: index + 1})}
                columns={right}
                value={filter.right}
                onChange={(v) => change({ right: v })}
              />
              <label>{tr("Operator")}<select
                  aria-label={tr("Filter {0} operator", {0: index + 1})}
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
                    ["eq", tr("Equals")],
                    ["in", tr("In a list")],
                    ["gte", tr("Greater than or equal")],
                    ["lt", tr("Less than")],
                    ["is_null", tr("Is null")],
                    ["is_not_null", tr("Is not null")],
                  ].map(([v, label]) => (
                    <option key={v} value={v}>
                      {tr(label)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!isNull && (
              <label>
                {filter.operator === "in" ? tr("Values (one per line)") : tr("Value")}
                <textarea
                  aria-label={tr("Filter {0} value", {0: index + 1})}
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
            >{tr("Remove criterion ")}{index + 1}
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
      >{tr("Add filter / batch")}</Button>
      <p className="muted small">{tr("Use equality or a list for a batch. Decimal values use a dot and retain their precision. Only compatible column types are accepted; no value normalization or implicit type conversion.")}</p>
    </Card>
  );
}

export function ColumnsEditor({ value, onChange, left, right }: Props) {
  const { t: tr } = useLanguage();
  return (
    <Card
      title={tr("Columns and timestamp interpretation")}
      subtitle={tr("Explicit exclusions define which values participate in Row Match Rate and Column Match Rate.")}
    >
      <p className="notice">{tr("Counts, filters and key validation still cover the entire selected scope. Identity columns cannot be excluded. Exclude both sides of a mapped pair when neither should participate; a remaining unpaired column blocks full row evaluation.")}</p>
      {sides.map((side, index) => {
        const columns = index ? right : left;
        const excluded = value.excluded_columns?.[side] ?? [];
        const zones = value.timestamp_timezones?.[side] ?? {};
        return (
          <section key={side}>
            <h3>{tr("Source ")}{index ? "B" : "A"}</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{tr("Compare")}</th>
                    <th>{tr("Column")}</th>
                    <th>{tr("Timestamp timezone")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(columns).map(([name, info]) => {
                    const identity =
                      (info.primary_key && !value.business_key?.length) ||
                      value.business_key?.some((p) => p[side] === name);
                    const timestamp =
                      info.family === "datetime" ||
                      /^(timestamp|datetime|smalldatetime)/i.test(
                        info.type ?? "",
                      );
                    const aware =
                      info.timestamp_kind === "aware" ||
                      /with time zone|timestamptz|datetimeoffset/i.test(
                        info.type ?? "",
                      );
                    return (
                      <tr key={name}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={tr("Compare {0} {1}", {0: index ? "B" : "A", 1: name})}
                            checked={!excluded.includes(name)}
                            disabled={!!identity && !excluded.includes(name)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? excluded.filter((n) => n !== name)
                                : [...excluded, name];
                              onChange({
                                ...value,
                                excluded_columns: {
                                  ...value.excluded_columns,
                                  [side]: next,
                                },
                                mapping: value.mapping?.filter(
                                  (p) => p[side] !== name,
                                ),
                              });
                            }}
                          />
                        </td>
                        <td>
                          {name}
                          <small className="muted">
                            {" "}
                            · {info.type}
                            {identity ? " · " + tr("identity") : ""}
                          </small>
                        </td>
                        <td>
                          {timestamp && !aware ? (
                            <input
                              aria-label={tr("Timezone {0} {1}", {0: index ? "B" : "A", 1: name})}
                              placeholder={tr("Unspecified — e.g. America/Sao_Paulo")}
                              disabled={excluded.includes(name)}
                              value={zones[name] ?? ""}
                              onChange={(e) => {
                                const next = { ...zones };
                                if (e.target.value) next[name] = e.target.value;
                                else delete next[name];
                                onChange({
                                  ...value,
                                  timestamp_timezones: {
                                    ...value.timestamp_timezones,
                                    [side]: next,
                                  },
                                });
                              }}
                            />
                          ) : timestamp ? (
                            tr("Uses its stored offset")
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <p className="notice">{tr("Choose the timezone that the stored clock values represent, not your browser timezone. UTC timestamps keep their instant. No timezone is assumed for naive timestamps; ambiguous or nonexistent local times remain not evaluated. The period timezone controls the window; timestamp interpretation controls value equality.")}</p>
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
  const { t: tr } = useLanguage();
  const manual = value.mapping ?? [],
    keys = value.business_key ?? [];
  const effective = suggestedPairs(left, right, manual);
  const keyFor = (pair: Pair) =>
    keys.some((k) => k.left === pair.left && k.right === pair.right);
  return (
    <Card
      title={tr("Column mapping & identity")}
      subtitle={tr("Manual pairs take precedence; remaining unambiguous names match automatically.")}
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{tr("Source column A")}</th>
              <th>{tr("Comparison column B")}</th>
              <th>{tr("Business key")}</th>
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
                      aria-label={tr("Map {0}", {0: name})}
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
                          ? tr("Auto → {0}", {0: pair.right})
                          : tr("Auto / no matching name")}
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
                      aria-label={tr("Business key {0}", {0: name})}
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
      <p className="notice">{tr("Select one or more mapped pairs for a business key. Nulls and duplicates are checked across the entire scope on both sources during execution. Invalid keys prevent record alignment and are reported explicitly. With no selection, compatible PK / non-null UNIQUE keys are discovered automatically.")}</p>
      <p className="muted small">{tr("Mapping preserves original values and native type differences. Columns without a pair prevent a complete Row Match Rate evaluation. The preview uses current metadata and is authoritative for matching.")}</p>
    </Card>
  );
}
