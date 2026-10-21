import { test, expect } from "@playwright/test";
test.skip(
  process.env.DATAQORE_ISOLATED_TEST !== "1",
  "Use the disposable full-stack fixture.",
);
test("real login → connection → catalog → profile → comparison → results", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "fetch") apiRequests.push(r.url());
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("DataQore-test-password-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-empty.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  for (const side of ["left", "right"]) {
    await page
      .getByRole("button", { name: "New connection", exact: true })
      .click();
    await page
      .getByLabel("Connection name", { exact: true })
      .fill("Source " + side);
    await page
      .getByLabel("Database type", { exact: true })
      .selectOption("sqlite");
    await page
      .getByLabel("SQLite file", { exact: true })
      .fill(side + ".sqlite");
    await page
      .getByRole("button", { name: "Test connection", exact: true })
      .click();
    await expect(
      page.getByText("Connection test succeeded.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest("[role=dialog]"),
      ),
    ).toBe(true);
    if (side === "left")
      await page.screenshot({
        path: "test-results/connection-modal.png",
        fullPage: true,
      });
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Source " + side, exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({
    path: "test-results/connections.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Catalog", exact: true }).click();
  for (const side of ["left", "right"]) {
    const option = await page
      .getByLabel("Connection", { exact: true })
      .locator("option")
      .filter({ hasText: "Source " + side })
      .getAttribute("value");
    await page.getByLabel("Connection", { exact: true }).selectOption(option!);
    await page
      .getByRole("button", { name: "Register dataset", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "records", exact: true }),
    ).toHaveCount(side === "left" ? 1 : 2);
  }
  await page
    .getByRole("link", { name: "records", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Run profile", exact: true }).click();
  await expect(
    page.getByText("succeeded", { exact: true }).first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "amount", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/profile.png", fullPage: true });
  await page.getByRole("link", { name: "Comparisons", exact: true }).click();
  await page.getByRole("link", { name: "New comparison", exact: true }).click();
  await page
    .getByLabel("Comparison name", { exact: true })
    .fill("Sales sample validation");
  const selects = page.getByLabel("Dataset", { exact: true });
  const choices = await selects.first().locator("option").all();
  const ids = await Promise.all(
    choices.slice(1).map((x) => x.getAttribute("value")),
  );
  await selects.first().selectOption(ids[0]!);
  await selects.nth(1).selectOption(ids[1]!);
  await page.screenshot({
    path: "test-results/wizard-datasets.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Column mapping & identity" }),
  ).toBeVisible();
  await page
    .getByLabel("Absolute tolerance (units)", { exact: true })
    .fill("0,50");
  await page.getByLabel("Relative tolerance (%)", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("non-negative decimal");
  await page.getByLabel("Relative tolerance (%)", { exact: true }).fill("1");
  const relativeHelp = page.getByRole("button", {
    name: "About relative tolerance",
    exact: true,
  });
  await relativeHelp.focus();
  await expect(page.getByRole("tooltip")).toContainText("Enter 1 for 1%");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page
    .getByRole("button", { name: "About absolute tolerance", exact: true })
    .hover();
  await expect(page.getByRole("tooltip")).toContainText("column’s units");
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await relativeHelp.click();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await expect(page.getByRole("tooltip")).toContainText("limits are not added");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/tolerance-help-mobile.png",
    fullPage: true,
  });
  await relativeHelp.click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: "test-results/wizard-rules.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("0,50 units absolute / 1% relative", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/wizard-review.png",
    fullPage: true,
  });
  const savedRequest = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/v1/comparisons"),
  );
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  const tolerancePayload = (await savedRequest).postDataJSON();
  expect(tolerancePayload.relative_tolerance).toBe("0.01");
  expect(tolerancePayload.absolute_tolerance).toBe("0.50");
  await expect(
    page.getByText("succeeded", { exact: true }).first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText("difference observed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/result.png", fullPage: true });
  await page
    .getByRole("link", { name: "Open differences", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect evidence", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Selected observation" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/differences.png",
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Aggregate differences", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("succeeded", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "Comparisons", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sales sample validation", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/comparisons.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Sales sample validation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Source configuration", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Rules", exact: true }).click();
  await expect(page.getByText("1%", { exact: true })).toBeVisible();
  await expect(page.getByText("0.50", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByLabel("Relative tolerance (%)", { exact: true }),
  ).toHaveValue("1");
  await expect(
    page.getByLabel("Absolute tolerance (units)", { exact: true }),
  ).toHaveValue("0.50");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const updated = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().includes("/api/v1/comparisons/"),
  );
  await page
    .getByRole("button", { name: "Save comparison", exact: true })
    .click();
  expect((await updated).postDataJSON().relative_tolerance).toBe("0.01");
  expect((await updated).postDataJSON().absolute_tolerance).toBe("0.50");
  await expect(
    page.getByRole("heading", { name: "Source configuration", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/comparison-detail.png",
    fullPage: true,
  });
  await page.getByRole('link',{name:'Schedules',exact:true}).last().click();
  await page.getByRole('button',{name:'New schedule',exact:true}).click();
  await page.getByLabel('Schedule name',{exact:true}).fill('Weekday guided validation');
  await page.getByLabel('Frequency',{exact:true}).selectOption('weekly');
  await page.getByLabel('Time',{exact:true}).fill('09:30');
  await page.getByLabel('Day of week',{exact:true}).selectOption('1');
  await expect(page.getByText('30 9 * * 1',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Save schedule',exact:true})).toBeEnabled();
  await page.getByLabel('Schedule enabled',{exact:true}).uncheck();
  await page.screenshot({path:'test-results/schedule-guided.png',fullPage:true});
  await page.getByRole('button',{name:'Save schedule',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Weekday guided validation',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('textbox',{name:'Cron expression',exact:true}).fill('0 8 * * 1-5');
  await expect(page.getByRole('button',{name:'Save schedule',exact:true})).toBeEnabled();
  await page.screenshot({path:'test-results/schedule-cron.png',fullPage:true});
  await page.getByRole('button',{name:'Save schedule',exact:true}).click();
  await expect(page.getByText('0 8 * * 1-5',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Comparisons',exact:true}).click();
  await page.getByRole('link',{name:'Sales sample validation',exact:true}).click();
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Run history", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  const source = page
    .locator("section.card")
    .filter({
      has: page.getByRole("heading", { name: "Source left", exact: true }),
    });
  await source.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    page.getByLabel("Replace all credentials", { exact: true }),
  ).not.toBeChecked();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("Source left revised");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Source left revised", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page
    .locator("tbody")
    .getByRole("link")
    .filter({ hasText: "comparison" })
    .first()
    .click();
  await expect(
    page.getByRole("link", { name: "Open differences", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^dataqore-run-.*\.json$/,
  );
  await page
    .getByRole("link", { name: "Open differences", exact: true })
    .click();
  await expect(
    page.getByText("succeeded", { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  expect(
    apiRequests.every(
      (u) => new URL(u).origin === process.env.DATAQORE_WEB_URL,
    ),
  ).toBe(true);
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
  expect(Object.keys(stored).every(key => ['dataqore.ui.theme', 'dataqore.ui.sidebar'].includes(key))).toBe(true);
  expect(JSON.stringify(stored)).not.toMatch(/password|access_token|refresh_token|PRIVATE_SECRET|DataQore-test-password/i);
});

test("equivalent scope, manual pairs and composite business key through the wizard", async ({
  page,
  request,
}) => {
  const base = process.env.DATAQORE_WEB_URL!;
  const login = await page.request.post(base + "/api/v1/auth/login", {
    headers: { Origin: base },
    data: {
      email: "admin@dataqore.test",
      password: "DataQore-test-password-2026",
    },
  });
  const headers = {
    Authorization: "Bearer " + (await login.json()).access_token,
  };
  const ids: string[] = [];
  for (const side of ["business-left", "business-right"]) {
    const connection = await request.post("/api/v1/connections", {
      headers,
      data: {
        name: side,
        connector: "sqlite",
        credentials: { database: side + ".sqlite" },
      },
    });
    expect(connection.status()).toBe(201);
    const dataset = await request.post("/api/v1/datasets", {
      headers,
      data: {
        connection_id: (await connection.json()).id,
        table_name: "records",
      },
    });
    expect(dataset.status()).toBe(201);
    ids.push((await dataset.json()).id);
  }
  await page.goto("/comparisons/new");
  await page
    .getByLabel("Comparison name", { exact: true })
    .fill("Scoped business comparison");
  await page
    .getByLabel("Dataset", { exact: true })
    .first()
    .selectOption(ids[0]);
  await page.getByLabel("Dataset", { exact: true }).nth(1).selectOption(ids[1]);
  await page.getByLabel("Period", { exact: true }).selectOption("fixed");
  await page.getByLabel("Period column A", { exact: true }).selectOption("day");
  await page
    .getByLabel("Period column B", { exact: true })
    .selectOption("loaded");
  await page
    .getByLabel("Start (inclusive)", { exact: true })
    .fill("2026-10-01");
  await page.getByLabel("End (exclusive)", { exact: true }).fill("2026-10-02");
  await page
    .getByRole("button", { name: "Add filter / batch", exact: true })
    .click();
  await page
    .getByLabel("Filter 1 column A", { exact: true })
    .selectOption("batch");
  await page
    .getByLabel("Filter 1 column B", { exact: true })
    .selectOption("batch");
  await page.getByLabel("Filter 1 value", { exact: true }).fill("B");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const [a, b] of [
    ["account", "customer"],
    ["item", "line"],
    ["day", "loaded"],
    ["amount", "total"],
  ])
    await page.getByLabel("Map " + a, { exact: true }).selectOption(b);
  await page.getByLabel("Business key account", { exact: true }).check();
  await page.getByLabel("Business key item", { exact: true }).check();
  await page.getByLabel("Business key item", { exact: true }).focus();
  await expect(
    page.getByLabel("Business key item", { exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/business-mapping-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  const preview = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/comparisons/preview") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const scope = await (await preview).json();
  expect(scope.mapping).toHaveLength(5);
  expect(scope.business_key).toHaveLength(2);
  await expect(
    page.getByRole("heading", { name: "Scope preview", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/business-preview.png",
    fullPage: true,
  });
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/comparisons") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  const comparison = await (await saved).json();
  await expect(
    page.getByText("succeeded", { exact: true }).first(),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText("compatible in sample", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Frozen scope, mapping & key validation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Source 1: Valid key", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/business-result.png",
    fullPage: true,
  });
  await page.goto(`/comparisons/${comparison.id}/edit`);
  await expect(page.getByLabel("Period", { exact: true })).toHaveValue("fixed");
  await expect(page.getByLabel("Filter 1 value", { exact: true })).toHaveValue(
    "B",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Map account", { exact: true })).toHaveValue(
    "customer",
  );
  await expect(
    page.getByLabel("Business key item", { exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Save comparison", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Source configuration", exact: true }),
  ).toBeVisible();
});
test.describe("touch tolerance help", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("opens and closes help by touch without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("DataQore-test-password-2026");
    await page.getByRole("button", { name: "Sign in", exact: true }).tap();
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .tap();
    await page.getByRole("link", { name: "Comparisons", exact: true }).tap();
    await page
      .getByRole("link", { name: "Sales sample validation", exact: true })
      .tap();
    await page.getByRole("tab", { name: "Rules", exact: true }).tap();
    const help = page.getByRole("button", {
      name: "About relative tolerance",
      exact: true,
    });
    await help.tap();
    await expect(page.getByRole("tooltip")).toContainText("Enter 1 for 1%");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: "test-results/tolerance-help-touch.png",
      fullPage: true,
    });
    await help.tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
});
test("unaligned comparisons and empty profiles remain explicit and inconclusive", async ({
  page,
  request,
}) => {
  const base = process.env.DATAQORE_WEB_URL!;
  const login = await page.request.post(base + "/api/v1/auth/login", {
    headers: { Origin: base },
    data: {
      email: "admin@dataqore.test",
      password: "DataQore-test-password-2026",
    },
  });
  expect(login.status()).toBe(200);
  const token = (await login.json()).access_token;
  const headers = { Authorization: "Bearer " + token };
  const datasets: string[] = [];
  for (const side of ["nokey-left", "nokey-right", "empty"]) {
    const c = await request.post("/api/v1/connections", {
      headers,
      data: {
        name: side,
        connector: "sqlite",
        credentials: { database: side + ".sqlite" },
      },
    });
    expect(c.status()).toBe(201);
    const d = await request.post("/api/v1/datasets", {
      headers,
      data: { connection_id: (await c.json()).id, table_name: "records" },
    });
    expect(d.status()).toBe(201);
    datasets.push((await d.json()).id);
  }
  const c = await request.post("/api/v1/comparisons", {
    headers,
    data: {
      name: "Unaligned observations",
      left_dataset_id: datasets[0],
      right_dataset_id: datasets[1],
    },
  });
  expect(c.status()).toBe(201);
  const comparison = (await c.json()).id;
  const key = "unaligned-acceptance-request";
  const r = await request.post(`/api/v1/comparisons/${comparison}/runs`, {
    headers: { ...headers, "Idempotency-Key": key },
    data: {},
  });
  expect(r.status()).toBe(202);
  const run = (await r.json()).id;
  const same = await request.post(`/api/v1/comparisons/${comparison}/runs`, {
    headers: { ...headers, "Idempotency-Key": key },
    data: {},
  });
  expect((await same.json()).id).toBe(run);
  const conflict = await request.post(
    `/api/v1/datasets/${datasets[2]}/profile-runs`,
    { headers: { ...headers, "Idempotency-Key": key }, data: {} },
  );
  expect(conflict.status()).toBe(409);
  const empty = await request.post(
    `/api/v1/datasets/${datasets[2]}/profile-runs`,
    { headers, data: {} },
  );
  expect(empty.status()).toBe(202);
  // The browser restores this session through its HttpOnly refresh cookie.
  await page.goto("/runs/" + run);
  await expect(page.getByText("profile only", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByText("Independent source profiles", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No safe comparison key was available.", { exact: false })).toBeVisible();
  await expect(page.getByText("Different sampled rows", { exact: true })).toHaveCount(0);
  await page.goto("/runs/" + (await empty.json()).id);
  await expect(page.getByText("inconclusive", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({
    path: "test-results/inconclusive.png",
    fullPage: true,
  });
});

test("overview daily comparison quality supports periods, details and mobile", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
  await page.getByLabel("Password", { exact: true }).fill("DataQore-test-password-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Quality over time", exact: true }) });
  await expect(page.getByText("COMPARISON AGREEMENT", { exact: true })).toBeVisible();
  await expect(page.getByText("Sample quality", { exact: true })).toBeVisible();
  await expect(card.getByLabel("Quality period")).toHaveValue("7");
  await expect(card.getByRole("list", { name: "Comparison legend" })).toContainText("Sales sample validation");
  for (const days of [15, 30]) {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/overview/quality-trend" && new URL(r.url()).searchParams.get('days') === String(days) && r.status() === 200);
    await card.getByLabel("Quality period").selectOption(String(days));
    const body = await (await response).json();
    expect(body.days).toBe(days);
    expect(body.timezone).toBe("America/Sao_Paulo");
    expect(body.metric).toBe("agreement");
    expect(body.series.every((s: any) => s.points.length === days)).toBe(true);
    await expect(card.getByRole("list", { name: "Comparison legend" })).toBeVisible();
  }
  const dot = card.locator('.recharts-line-dot[cx][cy]:not([cx="NaN"]):not([cy="NaN"])').filter({ visible: true }).first();
  await dot.hover();
  await expect(card.locator(".quality-tooltip")).toContainText("Agreement:");
  await expect(card.locator(".quality-tooltip")).toContainText("Coverage:");
  await page.screenshot({ path: "test-results/quality-trend-desktop.png", fullPage: true });
  await card.getByText("Daily run details", { exact: true }).click();
  await expect(card.locator(".quality-daily-details")).toContainText("equal /");
  await expect(card.locator(".quality-daily-details")).toContainText("No completed run");
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByLabel("Quality period").focus();
  await expect(card.getByLabel("Quality period")).toBeFocused();
  await page.screenshot({ path: "test-results/quality-trend-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("link", { name: "Environment settings", exact: true }).click();
  await expect(page.getByLabel("Agreement target (%)")).toHaveValue("95.0000");
  await page.getByLabel("Agreement target (%)").fill("97,5");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Environment settings saved.");
  await page.reload();
  await expect(page.getByLabel("Agreement target (%)")).toHaveValue("97.5000");
  await page.screenshot({ path: "test-results/environment-settings-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByText("Target 97.5%", { exact: false }).first()).toBeVisible();
  const reloadResponse=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/v1/overview" && r.status()===200);
  await page.reload();
  const fresh=await(await reloadResponse).json();
  expect(Number(fresh.comparison_agreement.percentage)).toBeLessThan(Number(fresh.sample_quality.percentage));
  const agreementCard=page.locator(".stat").filter({has:page.getByText("COMPARISON AGREEMENT",{exact:true})});
  await expect(agreementCard).toContainText(Number(fresh.comparison_agreement.percentage).toLocaleString("en-US", { maximumFractionDigits: 2 })+"%");
});

test("Databricks simulated Unity Catalog → view → profile → comparison → schedule", async ({ page }) => {
  await page.goto("/connections");
  await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
  await page.getByLabel("Password", { exact: true }).fill("DataQore-test-password-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "New connection", exact: true }).click();
  await page.getByLabel("Connection name", { exact: true }).fill("Unity acceptance");
  await page.getByLabel("Database type", { exact: true }).selectOption("databricks");
  await page.getByLabel("Server hostname", { exact: true }).fill("workspace.example.test");
  await page.getByLabel("HTTP path", { exact: true }).fill("/sql/1.0/warehouses/test");
  await page.getByLabel("Databricks authentication").selectOption("oauth_m2m");
  await page.getByLabel("Client ID", { exact: true }).fill("client-id");
  await page.getByLabel("Client secret", { exact: true }).fill("TEST_SECRET_ONLY");
  await page.screenshot({ path: "test-results/databricks-oauth.png", fullPage: true });
  await page.getByLabel("Databricks authentication").selectOption("pat");
  await page.getByLabel("Access token", { exact: true }).fill("TEST_PAT_ONLY");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Connection test succeeded", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unity acceptance", exact: true })).toBeVisible();
  const datasetResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/datasets" && r.request().method() === "GET");
  await page.getByRole("link", { name: "Catalog", exact: true }).click();
  const existing = await (await datasetResponse).json();
  const controlConnection = await page.getByLabel("Connection", { exact: true }).locator("option").filter({ hasText: /^Source right$/ }).getAttribute("value");
  const control = existing.items.find((d: any) => d.connection_id === controlConnection && !d.catalog_name && !d.schema_name && d.table_name === "records");
  expect(control?.id).toBeTruthy();
  await page.getByLabel("Connection", { exact: true }).selectOption({ label: "Unity acceptance" });
  await page.getByLabel("Unity catalog", { exact: true }).selectOption("other");
  await page.getByLabel("Schema", { exact: true }).selectOption("sales");
  await page.getByLabel("Unity catalog", { exact: true }).selectOption("main");
  await expect(page.getByLabel("Schema", { exact: true })).toHaveValue("");
  await page.getByLabel("Schema", { exact: true }).selectOption("sales");
  await expect(page.getByRole("cell", { name: "VIEW", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/databricks-catalog.png", fullPage: true });
  const view = page.locator("tr").filter({ has: page.getByRole("cell", { name: "records_view", exact: true }) });
  await view.getByRole("button", { name: "Register dataset", exact: true }).click();
  const link = page.getByRole("link", { name: "records_view", exact: true });
  await expect(link).toBeVisible();
  const id = (await link.getAttribute("href"))!.split("/").at(-1)!;
  await link.click();
  await page.getByRole("button", { name: "Run profile", exact: true }).click();
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Current table details", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Table details captured for this execution", exact: true })).toBeVisible();
  await expect(page.getByText("Databricks optimizer statistics", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Declared as text.", { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/databricks-profile-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/databricks-profile.png", fullPage: true });
  await page.goto("/comparisons/new");
  await page.getByLabel("Comparison name", { exact: true }).fill("Unity scheduled comparison");
  const datasets = page.getByLabel("Dataset", { exact: true });
  await datasets.first().selectOption(id);
  await datasets.nth(1).selectOption(control.id);
  await expect(datasets.first()).toContainText("main.sales.records_view");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Business key id", { exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("main.sales.records_view", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/databricks-result.png", fullPage: true });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await page.getByLabel("Schedule name", { exact: true }).fill("Unity browser schedule");
  await page.getByLabel("Comparison", { exact: true }).selectOption({ label: "Unity scheduled comparison" });
  await page.getByLabel("Schedule enabled", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unity browser schedule", exact: true })).toBeVisible();
});
