import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test.skip(
  !process.env.DATAQORE_EXISTING_RUNS_FILE,
  "Uses explicitly selected existing comparisons; never creates demo data.",
);
const { parse } = require("../../controller/node_modules/dotenv");
async function actual(path: string) {
  const key = parse(
    readFileSync(new URL("../../engine.env", import.meta.url)),
  ).ENGINE_API_KEY;
  const response = await fetch("http://127.0.0.1:8000/v1" + path, {
    headers: { "X-API-Key": key },
  });
  if (!response.ok)
    throw Error(`Read-only engine request failed: ${response.status}`);
  return response.json();
}
async function settings() {
  const { Client } = require("../../controller/node_modules/pg");
  const env = parse(
    readFileSync(new URL("../../controller.env", import.meta.url)),
  );
  const url = new URL(env.DATABASE_URL);
  url.searchParams.delete("schema");
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    const { rows } = await c.query(
      "SELECT row_match_target_percentage::text,updated_at FROM app.quality_settings WHERE id",
    );
    return {
      ...rows[0],
      updated_at: rows[0].updated_at.toISOString(),
      metric: "row_match_rate",
    };
  } finally {
    await c.end();
  }
}
async function preview(page: Page, manager = false) {
  // Authentication is previewed. Every metric and target is read from the real
  // configured internal databases. Writes are prohibited by this acceptance path.
  const user = {
    id: "readonly-preview",
    email: "preview@localhost",
    display_name: "Read-only acceptance",
    profile: manager ? "quality_manager" : "viewer",
    group: { id: "preview", name: "Preview" },
    permissions: [
      "dashboard.read",
      "results.read",
      ...(manager ? ["quality_settings.manage"] : []),
    ],
    must_change_password: false,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace("/api/v1", "");
    if (path === "/auth/refresh")
      return route.fulfill({ json: { access_token: "preview", user } });
    if (path === "/auth/me") return route.fulfill({ json: user });
    if (request.method() !== "GET")
      throw Error("Read-only acceptance attempted a write");
    return route.fulfill({
      json:
        path === "/settings/quality"
          ? await settings()
          : await actual(path + url.search),
    });
  });
}
test("real overview: five metrics, daily values, current target and selected comparison", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await preview(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Comparison quality over time" }),
  ).toBeVisible();
  await page
    .getByLabel("Comparison", { exact: true })
    .selectOption({ label: "sales" });
  await expect(
    page.getByRole("img", {
      name: "Row Match Rate by day for sales",
      exact: true,
    }),
  ).toBeVisible();
  const saved = await settings();
  await expect(page.locator(".overview-target-value")).toHaveText(
    `${Number(saved.row_match_target_percentage)}%`,
  );
  await page.getByRole("button", { name: "Key Coverage", exact: true }).click();
  await expect(
    page.getByRole("img", {
      name: "Key Coverage by day for sales",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Duplicate Key Rate", exact: true })
    .click();
  await expect(
    page.getByRole("img", {
      name: "Duplicate Key Rate by day for sales",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Row Count Match", exact: true })
    .click();
  await expect(
    page.getByRole("img", {
      name: "Row Count Match by day for sales",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Column Match Rate", exact: true })
    .click();
  await page
    .getByLabel("Column pair", { exact: true })
    .selectOption({ label: "Notes → Notes" });
  await expect(
    page.getByRole("img", {
      name: "Column Match Rate by day for sales",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Row Match Rate", exact: true })
    .click();
  await page.getByLabel("Period", { exact: true }).selectOption("30");
  await page
    .getByText("Daily values and denominators", { exact: true })
    .click();
  await expect(page.locator(".overview-daily tbody tr")).toHaveCount(30);
  await page
    .getByText("Daily values and denominators", { exact: true })
    .click();
  await page.screenshot({
    path: info.outputPath("overview-real-desktop.png"),
    fullPage: true,
  });
  await page.getByLabel("Search comparisons", { exact: true }).fill("sales-dr");
  await expect(page.locator(".overview-quality-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".overview-quality-table tbody tr")).toContainText(
    "Below target",
  );
  expect(errors).toEqual([]);
});
test("real overview mobile dark and read-only target settings", async ({
  page,
}, info) => {
  await preview(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Comparisons at a glance" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("overview-real-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "View target settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Quality target", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Minimum Row Match Rate (%)", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save target", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("quality manager sees the existing target in the editor", async ({
  page,
}, info) => {
  await preview(page, true);
  await page.goto("/settings/quality");
  await expect(
    page.getByRole("button", { name: "Save target", exact: true }),
  ).toBeVisible();
  const saved = await settings();
  await expect(
    page.getByLabel("Minimum Row Match Rate (%)", { exact: true }),
  ).toHaveValue(saved.row_match_target_percentage);
  await page.screenshot({
    path: info.outputPath("quality-target-settings.png"),
    fullPage: true,
  });
});
