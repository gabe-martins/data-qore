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
    page.getByRole("heading", { name: "Automatic column correspondence" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/wizard-rules.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.screenshot({
    path: "test-results/wizard-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Run now", exact: true }).click();
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
  await page.getByRole('link',{name:'Comparisons',exact:true}).click();
  await expect(page.getByRole('link',{name:'Sales sample validation',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/comparisons.png',fullPage:true});
  await page.getByRole('link',{name:'Sales sample validation',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Source configuration',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/comparison-detail.png',fullPage:true});
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
  await page.getByRole('tab',{name:'Runs',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Run history',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Connections',exact:true}).click();
  const source=page.locator('section.card').filter({has:page.getByRole('heading',{name:'Source left',exact:true})});
  await source.getByRole('button',{name:'Edit',exact:true}).click();
  await expect(page.getByLabel('Replace all credentials',{exact:true})).not.toBeChecked();
  await page.getByLabel('Connection name',{exact:true}).fill('Source left revised');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Source left revised',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Runs',exact:true}).click();
  await page.locator('tbody').getByRole('link').filter({hasText:'comparison'}).first().click();
  await expect(page.getByRole('link',{name:'Open differences',exact:true})).toBeVisible();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export JSON',exact:true}).click();
  expect((await download).suggestedFilename()).toMatch(/^dataqore-run-.*\.json$/);
  await page.getByRole('link',{name:'Open differences',exact:true}).click();
  await expect(page.getByText('succeeded',{exact:true}).first()).toBeVisible();
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
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
test("unaligned comparisons and empty profiles remain explicit and inconclusive", async ({
  page,
  request,
}) => {
  const base = process.env.DATAQORE_WEB_URL!;
  const login = await request.post(base + "/api/v1/auth/login", {
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
  // Authenticate through the UI; browser receives no engine key.
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("admin@dataqore.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("DataQore-test-password-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.goto("/runs/" + run);
  await expect(page.getByText("profile only", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByText("Not evaluated", { exact: true }).first(),
  ).toBeVisible();
  const empty = await request.post(
    `/api/v1/datasets/${datasets[2]}/profile-runs`,
    { headers, data: {} },
  );
  expect(empty.status()).toBe(202);
  await page.goto("/runs/" + (await empty.json()).id);
  await expect(page.getByText("inconclusive", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({
    path: "test-results/inconclusive.png",
    fullPage: true,
  });
});
