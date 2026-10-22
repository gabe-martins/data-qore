import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
test.skip(
  process.env.DATAQORE_ISOLATED_TEST !== "1",
  "Use the disposable full-stack fixture.",
);
async function setup(
  request: APIRequestContext,
  prefix: string,
  files = ["left", "right"],
) {
  const base = process.env.DATAQORE_CONTROLLER_URL! + "/api/v1";
  const login = await request.post(base + "/auth/login", {
    headers: { Origin: process.env.WEB_ORIGIN! },
    data: {
      email: "admin@dataqore.test",
      password: "DataQore-test-password-2026",
    },
  });
  expect(login.status()).toBe(200);
  const headers = {
    Authorization: "Bearer " + (await login.json()).access_token,
  };
  async function post(path: string, data: unknown, status = 201) {
    const r = await request.post(base + path, { headers, data });
    expect(r.status(), await r.text()).toBe(status);
    return r.json();
  }
  const datasets = [];
  for (const side of files) {
    const c = await post("/connections", {
      name: prefix + side,
      connector: "sqlite",
      credentials: { database: side + ".sqlite" },
    });
    datasets.push(
      await post("/datasets", { connection_id: c.id, table_name: "records" }),
    );
  }
  return { base, headers, post, datasets };
}
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("DataQore-test-password-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
}

test("closed scope → repeatable sample → five saved metrics → edit → history", async ({
  page,
  request,
}) => {
  const s = await setup(request, "Critical ");
  await login(page);
  await page.goto("/comparisons/new");
  await page.getByLabel("Name", { exact: true }).fill("Critical sample");
  await page
    .getByLabel("Source A", { exact: true })
    .selectOption(s.datasets[0].id);
  await page
    .getByLabel("Source B", { exact: true })
    .selectOption(s.datasets[1].id);
  await page.getByLabel("Period", { exact: true }).selectOption("fixed");
  await page.getByLabel("Period column A").selectOption("created");
  await page.getByLabel("Period column B").selectOption("created");
  await page.getByLabel("Start (inclusive)").fill("2026-10-01");
  await page.getByLabel("End (exclusive)").fill("2026-10-03");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Keys", { exact: true }).fill("2");
  await page.getByLabel("Seed (optional)").fill("18446744073709551615");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText(/2 requested keys/)).toBeVisible();
  await page.getByRole("button", { name: "Save and run", exact: true }).click();
  for (const name of [
    "Row Count Match",
    "Row Match Rate",
    "Key Coverage",
    "Duplicate Key Rate",
    "Column Match Rate",
  ])
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({
      timeout: 30000,
    });
  await expect(page.getByText("Sample quality", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Business quality", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("18446744073709551615", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/critical-metrics-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Open comparison" }).click();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByLabel("Sample size", { exact: true })
    .selectOption("percentage");
  await page.getByLabel("Percentage", { exact: true }).fill("50");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText(/1 requested keys/)).toBeVisible();
  await page
    .getByRole("button", { name: "Save comparison", exact: true })
    .click();
  await expect(page.getByText(/50% of the larger scope/)).toBeVisible();
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Run history" }),
  ).toBeVisible();
});

test("relative units, invalid identity and mobile results remain explicit", async ({
  page,
  request,
}) => {
  const s = await setup(request, "Invalid ", ["invalid-left", "invalid-right"]);
  const c = await s.post("/comparisons", {
    name: "Invalid key",
    left_dataset_id: s.datasets[0].id,
    right_dataset_id: s.datasets[1].id,
    comparison_options: { business_key: [{ left: "id", right: "id" }] },
    sampling_options: { rows: 1, seed: "42" },
  });
  const run = await s.post(`/comparisons/${c.id}/runs`, {}, 202);
  await login(page);
  await page.goto(`/runs/${run.id}`);
  await expect(
    page.getByRole("heading", { name: "Duplicate Key Rate", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText("difference observed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("invalid key", { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/critical-metrics-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/comparisons/new");
  await page.getByLabel("Name", { exact: true }).fill("Relative units");
  await page
    .getByLabel("Source A", { exact: true })
    .selectOption(s.datasets[0].id);
  await page
    .getByLabel("Source B", { exact: true })
    .selectOption(s.datasets[1].id);
  await page.getByLabel("Period", { exact: true }).selectOption("relative");
  for (const unit of ["hours", "days", "months"]) {
    await page.getByLabel("Period unit").selectOption(unit);
    await expect(page.getByLabel("Period unit")).toHaveValue(unit);
  }
  await page.getByLabel("Complete units").fill("2");
});
