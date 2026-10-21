import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
test.skip(process.env.DATAQORE_ISOLATED_TEST !== "1", "Use the disposable full-stack fixture.");

async function setup(request: APIRequestContext, prefix: string) {
  const base = process.env.DATAQORE_CONTROLLER_URL! + "/api/v1";
  const login = await request.post(base + "/auth/login", { headers: { Origin: process.env.WEB_ORIGIN! },
    data: { email: "admin@dataqore.test", password: "DataQore-test-password-2026" } });
  expect(login.status()).toBe(200);
  const headers = { Authorization: "Bearer " + (await login.json()).access_token };
  async function post(path: string, data: unknown, status = 201) {
    const response = await request.post(base + path, { headers, data });
    expect(response.status(), await response.text()).toBe(status); return response.json();
  }
  async function finish(path: string) {
    const run = await post(path, {}, 202);
    await expect.poll(async () => (await (await request.get(base + "/runs/" + run.id, { headers })).json()).status).toBe("succeeded");
    return run;
  }
  const datasets = [];
  for (const side of ["left", "right"]) {
    const connection = await post("/connections", { name: prefix + side, connector: "sqlite", credentials: { database: `evaluation-${side}.sqlite` } });
    datasets.push(await post("/datasets", { connection_id: connection.id, table_name: "records" }));
  }
  return { post, finish, datasets, base, headers };
}
async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
  await page.getByLabel("Password", { exact: true }).fill("DataQore-test-password-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
}

test("profile and independent results explain NULL values and preserve zero across themes", async ({ page, request }) => {
  const api = await setup(request, "Availability ");
  const profile = await api.finish(`/datasets/${api.datasets[0].id}/profile-runs`);
  const comparison = await api.post("/comparisons", { name: "Availability independent", left_dataset_id: api.datasets[0].id,
    right_dataset_id: api.datasets[1].id, mode: "independent_random" });
  const run = await api.finish(`/comparisons/${comparison.id}/runs`);
  await signIn(page);
  await page.goto(`/runs/${profile.id}`);
  await expect(page.getByText("Single-source profile", { exact: true })).toBeVisible();
  await expect(page.getByText("Different sampled rows", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cell agreement", { exact: true })).toHaveCount(0);
  const nullColumn = page.locator("details.column-profile").filter({ has: page.locator("summary", { hasText: /^null_text$/ }) });
  await nullColumn.locator("summary").focus(); await page.keyboard.press("Enter");
  await expect(nullColumn).toContainText("2 of 2 sampled values are NULL (100%).");
  await expect(nullColumn).toContainText("All sampled values are NULL");
  const numeric = page.locator("details.column-profile").filter({ has: page.locator("summary", { hasText: /^amount$/ }) });
  await numeric.locator("summary").click();
  await expect(numeric.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^mean$/ }) }).locator("dd")).toHaveText("0");
  await page.screenshot({ path: "test-results/evaluation-profile-light.png", fullPage: true });
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByText("Independent source profiles", { exact: true })).toBeVisible();
  await expect(page.getByText("Independent sampling was selected.", { exact: false })).toBeVisible();
  await expect(page.getByText("Missing in source sample", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).check(); await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Independent source profiles", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/evaluation-independent-dark-mobile.png", fullPage: true });
  await page.goto(`/datasets/${api.datasets[0].id}`);
  await expect(page.locator("article.column-profile").filter({ has: page.getByRole("heading", { name: "null_text", exact: true }) })).toContainText("All sampled values are NULL");
});

test("invalid business key is distinct from missing alignment and Databricks simulation remains descriptive", async ({ page, request }) => {
  const api = await setup(request, "Key availability ");
  const comparison = await api.post("/comparisons", { name: "Availability invalid key", left_dataset_id: api.datasets[0].id,
    right_dataset_id: api.datasets[1].id, mode: "matched_keys", comparison_options: { business_key: [{ left: "label", right: "label" }] } });
  const invalid = await api.finish(`/comparisons/${comparison.id}/runs`);
  const connection = await api.post("/connections", { name: "Availability Databricks simulation", connector: "databricks",
    credentials: { hostname: "workspace.example.test", http_path: "/sql/1.0/warehouses/test", auth_type: "pat", access_token: "test-only-token" } });
  const dataset = await api.post("/datasets", { connection_id: connection.id, catalog_name: "main", schema_name: "sales", table_name: "records" });
  const definition = await api.post("/comparisons", { name: "Availability Databricks independent", left_dataset_id: api.datasets[0].id,
    right_dataset_id: dataset.id, mode: "independent_random" });
  const independent = await api.finish(`/comparisons/${definition.id}/runs`);
  await signIn(page); await page.goto(`/runs/${invalid.id}`);
  await expect(page.getByText("Invalid key — inconclusive", { exact: true })).toBeVisible();
  await expect(page.getByText(/2 scoped rows · 0 null-key rows · 1 duplicate groups/)).toHaveCount(2);
  await page.goto(`/runs/${independent.id}`);
  await expect(page.getByText("Independent source profiles", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Availability Databricks simulation/ })).toBeVisible();
});
