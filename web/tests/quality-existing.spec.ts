import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const enabled = !!process.env.DATAQORE_EXISTING_RUNS_FILE;
test.skip(
  !enabled,
  "Read-only acceptance uses explicitly selected existing comparisons.",
);
type Existing = {
  name: string;
  comparison_id: string;
  run_id: string;
  historical_run_id: string;
};
function config() {
  const { parse } = require("../../controller/node_modules/dotenv");
  const key = parse(
    readFileSync(new URL("../../engine.env", import.meta.url)),
  ).ENGINE_API_KEY;
  return {
    key,
    runs: JSON.parse(
      readFileSync(process.env.DATAQORE_EXISTING_RUNS_FILE!, "utf8"),
    ) as Existing[],
  };
}
async function real(path: string) {
  const response = await fetch("http://127.0.0.1:8000/v1" + path, {
    headers: { "X-API-Key": config().key },
  });
  if (!response.ok)
    throw new Error(
      `Read-only engine request returned ${response.status} for ${path.split("?")[0]}`,
    );
  return response.json();
}
async function preview(page: Page) {
  // Only authentication is simulated. Every result and record comes from the
  // existing execution via read-only requests. No users or source data are created.
  const user = {
    id: "readonly-preview",
    email: "preview@localhost",
    display_name: "Read-only preview",
    profile: "viewer",
    group: { id: "preview", name: "Results Viewer" },
    permissions: ["dashboard.read", "results.read"],
    must_change_password: false,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", "");
    if (path === "/auth/refresh")
      return route.fulfill({
        json: { access_token: "readonly-preview", user },
      });
    if (path === "/auth/me") return route.fulfill({ json: user });
    if (request.method() !== "GET" || path.startsWith("/comparisons"))
      throw new Error("Viewer attempted a non-result operation");
    return route.fulfill({ json: await real(path + url.search) });
  });
}

test("real saved execution: summary, column filter, record evidence and export", async ({
  page,
}, testInfo) => {
  const saved = config().runs.find((r) => r.name === "sales")!;
  const quality = await real(`/runs/${saved.run_id}/quality`);
  expect(quality.run.status).toBe("succeeded");
  expect(quality.evidence.status).toBe("available");
  await preview(page);
  await page.goto(`/comparisons/${saved.comparison_id}?run_id=${saved.run_id}`);
  await expect(
    page.getByRole("heading", { name: "Comparison Quality", exact: true }),
  ).toBeVisible();
  const row = quality.result.metrics.row_match_rate;
  await expect(
    page.locator(".quality-headline > div > strong").first(),
  ).toHaveText(
    Number(row.percentage).toLocaleString("en-US", {
      maximumFractionDigits: 2,
    }) + "%",
  );
  await expect(
    page.getByRole("button", { name: "Run comparison", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Inspect column", exact: true })
    .first()
    .click();
  await expect(
    page.getByLabel("Affected column", { exact: true }),
  ).not.toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Inspect record", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect record", exact: true })
    .first()
    .click();
  await expect(page.locator(".evidence-cells")).toBeVisible();
  await expect(page.locator(".evidence-different").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download captured records", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe(
    `evidence-${saved.run_id}.json`,
  );
  await page
    .locator(".comparison-quality > .card")
    .first()
    .screenshot({ path: testInfo.outputPath("quality-summary.png") });
  await page.screenshot({
    path: testInfo.outputPath("quality-existing-desktop.png"),
    fullPage: true,
  });
});

test("historical evidence stays unavailable and execution selection does not mix results", async ({
  page,
}) => {
  const saved = config().runs.find((r) => r.name === "sales")!;
  await preview(page);
  await page.goto(
    `/comparisons/${saved.comparison_id}?run_id=${saved.historical_run_id}`,
  );
  await expect(
    page.getByText(/Not captured: this historical execution/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Download captured records",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByLabel("Selected execution", { exact: true })
    .selectOption(saved.run_id);
  await expect(page).toHaveURL(new RegExp(saved.run_id));
  await expect(page.getByText(/Captured sample: this table/)).toBeVisible();
});

test("existing absence comparison and mobile dark view use their own execution", async ({
  page,
}, testInfo) => {
  const saved = config().runs.find((r) => r.name === "sales-dr")!;
  const quality = await real(`/runs/${saved.run_id}/quality`);
  expect(quality.run.status).toBe("succeeded");
  await preview(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(`/comparisons/${saved.comparison_id}?run_id=${saved.run_id}`);
  await expect(
    page.getByRole("heading", { name: "Comparison Quality", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Record state", { exact: true })
    .selectOption("only_source");
  await expect(
    page.getByText(/captured records match these filters/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("quality-existing-mobile.png"),
    fullPage: true,
  });
});
