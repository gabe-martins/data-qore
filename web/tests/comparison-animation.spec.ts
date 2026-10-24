import { adminUser } from "./access-fixture";
import { test, expect, type Page } from "@playwright/test";

// Controlled states keep coverage independent of source data or worker speed.
async function fixture(page: Page) {
  const run = {
    id: "animation-run",
    comparison_id: "animation-comparison",
    kind: "comparison",
    status: "queued",
    requested_at: "2026-10-21T12:00:00Z",
    parameters: {},
    error_code: "test_failure",
    error_message: "Test execution failed.",
  };
  const comparison = {
    id: run.comparison_id,
    name: "Animation comparison",
    is_active: true,
    left_dataset_id: "left",
    right_dataset_id: "right",
    sampling_options: { method: "rows", rows: 1 },
  };
  const rate = {
    numerator: 1,
    denominator: 1,
    total: 1,
    not_evaluated: 0,
    percentage: "100",
    coverage_percentage: "100",
    reason: null,
  };
  const result = {
    run_id: run.id,
    conclusion: "compatible_in_sample",
    result: {
      summary: { status: "compatible_in_sample" },
      warnings: [],
      resolved_scope: {},
      sampling_plan: {
        seed: "42",
        requested_keys: 1,
        selected_keys: 1,
        method: "rows",
        repeatability: "Same seed and unchanged key set.",
      },
      metrics: {
        row_count_match: {
          reference_count: 1,
          target_count: 1,
          equal: true,
          absolute_difference: 0,
          signed_difference: 0,
          percentage_difference: "0",
        },
        row_match_rate: {
          ...rate,
          different_rows: 0,
          unknown_rows: 0,
          missing_rows: 0,
        },
        key_coverage: {
          reference_to_target: rate,
          target_to_reference: rate,
          selected_keys: 1,
          missing_in_reference: 0,
          missing_in_target: 0,
          unavailable_in_both: 0,
        },
        duplicate_key_rate: [1, 2].map((source) => ({
          ...rate,
          percentage: "0",
          numerator: 0,
          source,
          columns: ["id"],
          duplicate_groups: 0,
          null_key_rows: 0,
        })),
        column_match_rate: [
          {
            ...rate,
            left_column: "id",
            right_column: "id",
            different_values: 0,
            unknown_values: 0,
          },
        ],
      },
    },
  };
  let requests = 0;
  let completeStart: ((fail?: boolean) => void) | undefined;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (path === "/auth/refresh")
      return json({ access_token: "test", user: adminUser });
    if (path === `/comparisons/${comparison.id}/runs`) {
      requests++;
      const fail = await new Promise<boolean>((resolve) => {
        completeStart = (fail = false) => resolve(fail);
      });
      return fail
        ? json({ code: "unavailable", message: "Please try again." }, 503)
        : json(run, 202);
    }
    if (path === `/runs/${run.id}`) return json(run);
    if (path === `/runs/${run.id}/result`) return json(result);
    if (path === `/runs/${run.id}/quality`)
      return json({
        run,
        comparison_name: comparison.name,
        result: run.status === "succeeded" ? result.result : null,
        dimensions: [],
        diagnostics: [],
        evidence: { status: "not_captured" },
      });
    if (path === `/comparisons/${comparison.id}`) return json(comparison);
    if (path === "/runs")
      return json({ items: [run], total: 1, limit: 20, offset: 0 });
    throw new Error(`Unexpected API request: ${path}`);
  });
  return {
    run,
    comparison,
    requests: () => requests,
    completeStart: (fail = false) => completeStart!(fail),
  };
}

test("manual start is guarded, recovers from error and opens the animated queued run", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(`/comparisons/${f.comparison.id}`);
  const start = page.getByRole("button", {
    name: "Run comparison",
    exact: true,
  });
  await start.click();
  await expect(start).toBeDisabled();
  await expect.poll(f.requests).toBe(1);
  f.completeStart(true);
  await expect(page.getByRole("alert")).toContainText("Please try again.");
  await expect(start).toBeEnabled();
  await start.click();
  await expect.poll(f.requests).toBe(2);
  f.completeStart();
  await expect(page).toHaveURL(
    new RegExp(`/comparisons/${f.comparison.id}\\?run_id=${f.run.id}$`),
  );
  await expect(page.getByRole("status")).toHaveText("Comparison queued");
  await expect(page.locator(".comparison-motion")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const terminal of ["succeeded", "failed"]) {
  test(`polling transitions queued → running → ${terminal}`, async ({
    page,
  }) => {
    const f = await fixture(page);
    await page.goto(`/runs/${f.run.id}`);
    await expect(page.getByRole("status")).toHaveText("Comparison queued");
    f.run.status = "running";
    await expect(page.getByRole("status")).toHaveText(
      "Analyzing comparison data",
    );
    f.run.status = terminal;
    await expect(page.locator(".comparison-wait")).toHaveCount(0);
    if (terminal === "failed")
      await expect(page.getByRole("alert")).toContainText(
        "Test execution failed.",
      );
    else
      await expect(
        page.getByRole("link", {
          name: "Open comparison quality",
          exact: true,
        }),
      ).toBeVisible();
    await expect(page.getByText(terminal, { exact: true })).toBeVisible();
  });
}

test("an existing run opened from history also displays the animation", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/runs");
  await page.locator(`a[href='/runs/${f.run.id}']`).click();
  await expect(page.getByRole("status")).toHaveText("Comparison queued");
  await expect(page.locator(".comparison-motion")).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const mobile of [false, true]) {
    test(`${theme}, ${mobile ? "mobile" : "desktop"}: themed motion and reduced motion`, async ({
      page,
    }) => {
      const f = await fixture(page);
      f.run.status = "running";
      await page.emulateMedia({
        colorScheme: theme,
        reducedMotion: "no-preference",
      });
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/runs/${f.run.id}`);
      const graphic = page.locator(".comparison-motion");
      await expect(graphic).toBeVisible();
      await expect(graphic).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".comparison-motion-scan").first()).toHaveCSS(
        "animation-duration",
        "4s",
      );
      expect(
        await graphic.evaluate((el) => el.getBoundingClientRect().width),
      ).toBeLessThanOrEqual(360);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/comparison-animation-${theme}-${mobile ? "mobile" : "desktop"}.png`,
        fullPage: true,
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await graphic.evaluate(
          (el) => el.getAnimations({ subtree: true }).length,
        ),
      ).toBe(0);
      await expect(page.getByRole("status")).toHaveText(
        "Analyzing comparison data",
      );
      f.run.status = "queued";
      await expect(page.getByRole("status")).toHaveText("Comparison queued");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(page.locator(".comparison-motion-table").first()).toHaveCSS(
        "animation-name",
        "comparison-breathe",
      );
    });
  }
}
