import type { Page } from "@playwright/test";
import { adminUser } from "./access-fixture";
export const rate = { numerator: 991, denominator: 1000, total: 1000, not_evaluated: 0, percentage: "99.1", coverage_percentage: "100", reason: null };
export const run = { id: "run-1", comparison_id: "comparison-1", name: "English source name", kind: "comparison", status: "succeeded", requested_at: "2026-10-24T12:00:00Z", started_at: "2026-10-24T12:00:01Z", finished_at: "2026-10-24T12:00:03Z", parameters: {}, conclusion: "difference_observed", error_code: null, error_message: null };
export const metrics = {
  row_match_rate: { ...rate, formula: "100 * equal_rows / evaluated_row_positions", different_rows: 9, unknown_rows: 0, missing_rows: 0 },
  row_count_match: { reference_count: 1200000, target_count: 1200000, equal: true, signed_difference: 0, absolute_difference: 0, percentage_difference: "0", scope: "entire_selected_scope" },
  key_coverage: { reference_to_target: { ...rate, numerator: 1000, percentage: "100" }, target_to_reference: { ...rate, numerator: 1000, percentage: "100" }, selected_keys: 1000, missing_in_reference: 0, missing_in_target: 0 },
  duplicate_key_rate: [1, 2].map(source => ({ ...rate, source, numerator: 0, percentage: "0", duplicate_groups: 0, null_key_rows: 0, columns: ["id"], formula: "100 * duplicate_excess_rows / non_null_key_rows" })),
  column_match_rate: [{ ...rate, left_column: "Notes", right_column: "Notes", different_values: 9, unknown_values: 0, formula: "100 * equal_values / evaluated_column_positions" }],
};
const comparison = { id: "comparison-1", name: "English source name", is_active: true, left_dataset_id: "left", right_dataset_id: "right", comparison_options: {}, sampling_options: { method: "rows", rows: 1000 }, absolute_tolerance: "0", relative_tolerance: "0" };
const datasets = ["left", "right"].map(id => ({ id, connection_id: "connection-1", catalog_name: "", schema_name: "public", table_name: id, metadata: { columns: { id: { type: "INTEGER", primary_key: true, nullable: false }, Notes: { type: "TEXT", nullable: true }, SaleDate: { type: "TIMESTAMP", family: "datetime", timestamp_kind: "naive" } } } }));
export async function languageFixture(page: Page, temporary = false, viewer = false) {
  const calls: { method: string; path: string; body: any }[] = [];
  let signedOut = false;
  const pageOf = (items: unknown[]) => ({ items, total: items.length, limit: 20, offset: 0 });
  await page.route("**/api/v1/**", async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.replace("/api/v1", "");
    let body; try { body = req.postDataJSON(); } catch { body = null; }
    calls.push({ method: req.method(), path: p, body });
    const json = (data: unknown, status = 200) => route.fulfill({ json: data, status });
    if (p === "/auth/refresh") return json(signedOut ? {} : { access_token: "test", user: { ...adminUser, must_change_password: temporary, permissions: viewer ? ["dashboard.read", "results.read"] : [...adminUser.permissions, "quality_settings.manage"] } }, signedOut ? 401 : 200);
    if (p === "/auth/logout") { signedOut = true; return json({ status: "ok" }); }
    if (p === "/settings/quality") return json({ row_match_target_percentage: body?.row_match_target_percentage == null ? "95" : String(body.row_match_target_percentage), metric: "row_match_rate", updated_at: "2026-10-24T12:00:00Z" });
    if (p === "/overview") return json({ row_match_rate: { percentage: "99.1", passed: 991, evaluated: 1000, total: 1000, coverage_percentage: "100" }, active_comparisons: 1, evaluated_comparisons: 1, latest_conclusions: { difference_observed: 1 }, attention: [], recent_runs: [run] });
    if (p === "/overview/comparisons") return json(pageOf([{ comparison_id: comparison.id, name: comparison.name, source_table: "source_table", target_table: "target_table", run_id: run.id, status: "succeeded", conclusion: run.conclusion, finished_at: run.finished_at, metrics, column_pairs: [{ left_column: "Notes", right_column: "Notes" }], points: [{ day: "2026-10-24", percentage: "99.1" }] }]));
    if (p === "/overview/metric-trend") return json({ metric: url.searchParams.get("metric"), points: [{ day: "2026-10-24", run_id: run.id, status: run.status, values: [{ ...rate, label: url.searchParams.get("metric") === "column_match_rate" ? "Notes → Notes" : "Row Match Rate", scope: "sample" }] }] });
    if (p === "/connections") return json(pageOf([{ id: "connection-1", name: "Connection in English", connector: "postgresql", dataset_count: 2, is_active: true }]));
    if (p === "/connectors") return json(["postgresql", "mysql", "mssql", "oracle", "sqlite", "databricks"].map(connector => ({ connector, available: true })));
    if (p === "/connections/connection-1/schemas") return json(pageOf(["public"]));
    if (p === "/connections/connection-1/tables") return json(pageOf([{ schema_name: "public", table_name: "source_table" }]));
    if (p === "/datasets") return json(pageOf(datasets));
    if (p.startsWith("/datasets/")) return json(datasets.find(d => d.id === p.split("/")[2]) ?? datasets[0]);
    if (p === "/comparison-summaries") return json(pageOf([{ ...comparison, latest_run: run, latest_result: metrics }]));
    if (p === "/comparisons/preview") return json({ sample_target: 1000, scope_counts: [1200000, 1200000], business_key: [], suggested_business_key: [{ left: "id", right: "id" }], excluded_columns: { left: [], right: [] }, timestamp_timezones: {} });
    if (p === "/comparisons") return json(pageOf([comparison]));
    if (p === "/comparisons/comparison-1") return json(comparison);
    if (p === "/runs") return json(pageOf([run]));
    if (p === "/runs/run-1") return json(run);
    if (p === "/runs/run-1/result") return json({ run_id: run.id, conclusion: run.conclusion, result: { metrics } });
    if (p === "/runs/run-1/quality") return json({ run, comparison_name: comparison.name,
      result: { metrics, summary: { status: run.conclusion }, sampling_plan: { seed: "42", percentage_base: 1200000 }, key_validation: [{ columns: ["id"] }], column_directory: [{ id: "pair_0", left_column: "Notes", right_column: "Notes" }], column_count: 1, columns_requiring_review: 1, warnings: ["Source 1: reads use best effort; separate queries may observe different states.", "Sampled key and record metrics do not establish equality of entire tables."] },
      dimensions: [{ id: "consistency", name: "Consistency", description: "Row and column correspondence under the frozen comparison rules.", status: "attention", measures: [{ label: "Row Match Rate", ...rate }] }],
      diagnostics: [{ id: "content", label: "Different paired records", count: 9, scope: "sample", severity: "attention", record_state: "different" }],
      evidence: { status: "available", expires_at: "2026-11-23T12:00:00Z", stored_positions: 1000, selected_positions: 1000 } });
    if (p === "/runs/run-1/quality/export") return json({ manifest: { status: "available", stored_positions: 1 }, records: [{ key: ["123"], state: "different", left: { Notes: "Overview" }, right: { Notes: " " } }] });
    if (p === "/runs/run-1/quality/columns") return json(pageOf([{ id: "pair_0", left_column: "Notes", right_column: "Notes", left_type: "TEXT", right_type: "TEXT", status: "attention", metric: metrics.column_match_rate[0] }]));
    if (p === "/runs/run-1/quality/records") return json(pageOf([{ id: 0, key: [{ kind: "value", raw: "123" }], state: "different", affected_columns: ["pair_0"] }]));
    if (p === "/runs/run-1/quality/records/0") return json({ id: 0, cells: [{ id: "pair_0", left_column: "Notes", right_column: "Notes", status: "different", left: { kind: "value", raw: "Overview" }, right: { kind: "value", raw: " " } }] });
    if (p === "/schedules") return json(pageOf([{ id: "schedule-1", comparison_id: comparison.id, name: "Schedule in English", is_active: true, cron_expression: "0 8 * * *", timezone: "America/Sao_Paulo", next_run_at: "2026-10-25T11:00:00Z" }]));
    if (p === "/schedules/preview") return json({ cron_expression: body.cron_expression, timezone: body.timezone, next_runs: ["2026-10-25T11:00:00Z"] });
    if (p.endsWith("/dispatches")) return json(pageOf([{ id: "dispatch-1", scheduled_for: "2026-10-24T11:00:00Z", status: "dispatched", attempts: 1, run_id: run.id }]));
    if (p === "/groups") return json(pageOf([{ id: "g", name: "Finance", description: "Original description", profile: "viewer", user_count: 1 }]));
    if (p === "/users") return json(pageOf([{ ...adminUser, is_active: true, group: { ...adminUser.group, profile: "platform_admin" } }]));
    if (p === "/audit-log") return json(pageOf([{ id: "a", created_at: run.requested_at, action: "quality_target_updated", resource_type: "quality_settings", outcome: "success", request_id: "request-1" }]));
    throw Error(`Unexpected request ${req.method()} ${p}`);
  });
  return calls;
}
