import { test, expect, type Page } from "@playwright/test";

async function resultFixture(
  page: Page,
  { total = 1000, evaluated = 10, equal = 0 } = {},
) {
  const rate = {
    numerator: equal,
    denominator: evaluated,
    total,
    not_evaluated: total - evaluated,
    percentage: evaluated ? String((100 * equal) / evaluated) : null,
    coverage_percentage: total ? String((100 * evaluated) / total) : null,
    reason: null,
  };
  const run = {
    id: "interpretation",
    comparison_id: null,
    kind: "comparison",
    status: "succeeded",
    parameters: {},
  };
  const result = {
    summary: { status: "difference_observed" },
    warnings: [],
    sampling_plan: { seed: "42", requested_keys: 1000, selected_keys: total },
    resolved_scope: {},
    metrics: {
      row_count_match: {
        reference_count: 1200000,
        target_count: 1200000,
        equal: true,
        absolute_difference: 0,
        signed_difference: 0,
        percentage_difference: "0",
      },
      row_match_rate: {
        ...rate,
        different_rows: evaluated - equal,
        unknown_rows: total - evaluated,
        missing_rows: 0,
      },
      key_coverage: {
        reference_to_target: rate,
        target_to_reference: rate,
        selected_keys: total,
        missing_in_reference: 0,
        missing_in_target: 0,
        unavailable_in_both: 0,
      },
      duplicate_key_rate: [1, 2].map((source) => ({
        ...rate,
        numerator: 0,
        percentage: "0",
        source,
        columns: ["id"],
        duplicate_groups: 0,
        null_key_rows: 0,
      })),
      column_match_rate: [
        {
          ...rate,
          left_column: "SaleId",
          right_column: "SaleId",
          different_values: 0,
          unknown_values: 0,
        },
        {
          ...rate,
          left_column: "Notes",
          right_column: "Notes",
          different_values: evaluated - equal,
          unknown_values: 0,
        },
      ],
    },
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/refresh"))
      return route.fulfill({
        json: {
          access_token: "test",
          user: {
            id: "test",
            display_name: "Presentation",
            email: "test@example.com",
            role: "admin",
          },
        },
      });
    if (path.endsWith("/result")) return route.fulfill({ json: { result } });
    if (path.endsWith("/runs/interpretation"))
      return route.fulfill({ json: run });
    throw new Error(`Unexpected request ${path}`);
  });
  await page.goto("/runs/interpretation");
  await expect(
    page.getByRole("heading", { name: "Result interpretation", exact: true }),
  ).toBeVisible();
}

test("zero row match explains its partial denominator and prioritizes differing columns", async ({
  page,
}) => {
  await resultFixture(page);
  await expect(
    page.getByText(
      /Partial evaluation: the match rate applies only to 10 evaluated positions/,
    ),
  ).toBeVisible();
  const columns = page
    .getByRole("heading", { name: "Column Match Rate", exact: true })
    .locator("..")
    .locator("tbody tr");
  await expect(columns.first()).toContainText("Notes");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("zero count difference and duplicate rate are identified as healthy results", async ({
  page,
}) => {
  await resultFixture(page, { total: 1000, evaluated: 1000, equal: 991 });
  await expect(
    page.getByText("Counts match. A 0% count difference means equal volumes.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No duplicate or null keys found. Here, 0% is the expected result.",
      { exact: true },
    ),
  ).toHaveCount(2);
  await expect(
    page.getByText(
      "All 1,000 selected row positions were evaluated. 991 match and 9 differ.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("empty selection is unavailable rather than a completed evaluation", async ({
  page,
}) => {
  await resultFixture(page, { total: 0, evaluated: 0, equal: 0 });
  await expect(
    page.getByText(/No row positions are available for evaluation/),
  ).toBeVisible();
  await expect(
    page.getByText(/All 0 selected row positions were evaluated/),
  ).toHaveCount(0);
});
