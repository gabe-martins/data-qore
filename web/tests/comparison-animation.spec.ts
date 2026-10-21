import { test, expect, type Page } from "@playwright/test";

// Browser coverage with controlled API states; no database or worker required.
async function fixture(page: Page) {
  const run = { id: "animation-run", comparison_id: "animation-comparison", kind: "comparison",
    status: "queued", requested_at: "2026-10-21T12:00:00Z", parameters: {} };
  const comparison = { id: run.comparison_id, name: "Animation comparison", is_active: true,
    mode: "matched_keys", left_dataset_id: "left", right_dataset_id: "right" };
  let requests = 0;
  let completeStart: ((fail?: boolean) => void) | undefined;
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/auth/refresh") return json({ access_token: "test", user: { id: "user", display_name: "Designer", email: "test@example.com", role: "admin" } });
    if (path === `/comparisons/${comparison.id}/runs`) {
      requests++;
      const fail = await new Promise<boolean>(resolve => { completeStart = (fail = false) => resolve(fail); });
      return fail ? json({ code: "unavailable", message: "Please try again." }, 503) : json(run, 202);
    }
    if (path === `/runs/${run.id}`) return json(run);
    if (path === `/runs/${run.id}/result`) return json({ run_id: run.id, conclusion: "inconclusive", result: {} });
    if (path === `/comparisons/${comparison.id}`) return json(comparison);
    if (path === "/comparison-summaries") return json({ items: [comparison], total: 1 });
    if (path === "/runs") return json({ items: [], total: 0 });
    throw new Error(`Unexpected API request: ${path}`);
  });
  return { run, comparison, requests: () => requests, completeStart: (fail = false) => completeStart!(fail) };
}

for (const entry of ["list", "detail"]) {
  test(`${entry}: start is guarded, recovers from error and opens the queued run`, async ({ page }) => {
    const f = await fixture(page);
    await page.goto(entry === "list" ? "/comparisons" : `/comparisons/${f.comparison.id}`);
    const start = page.getByRole("button", { name: "Run now", exact: true });
    await start.click();
    await expect(page.getByRole("button", { name: "Starting…" })).toBeDisabled();
    await expect.poll(f.requests).toBe(1);
    f.completeStart(true);
    await expect(page.getByRole("alert")).toContainText("Please try again.");
    await expect(start).toBeEnabled();
    await start.click();
    await expect.poll(f.requests).toBe(2);
    f.completeStart();
    await expect(page).toHaveURL(new RegExp(`/runs/${f.run.id}$`));
    await expect(page.getByRole("status")).toHaveText("Comparison queued");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

for (const terminal of ["succeeded", "failed"]) {
  test(`polling transitions from queued to running to ${terminal}`, async ({ page }) => {
    const f = await fixture(page);
    await page.goto(`/runs/${f.run.id}`);
    await expect(page.getByRole("status")).toHaveText("Comparison queued");
    f.run.status = "running";
    await expect(page.getByRole("status")).toHaveText("Analyzing comparison data");
    f.run.status = terminal;
    await expect(page.locator(".comparison-wait")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: terminal === "failed" ? "Execution failed" : "Run metadata", exact: true })).toBeVisible();
    await expect(page.getByText(terminal, { exact: true })).toBeVisible();
  });
}

test("profile runs retain their existing waiting state", async ({ page }) => {
  const f = await fixture(page);
  f.run.kind = "profile";
  await page.goto(`/runs/${f.run.id}`);
  await expect(page.getByText("Waiting for the worker", { exact: true })).toBeVisible();
  f.run.status = "running";
  await expect(page.getByText("Analysis in progress", { exact: true })).toBeVisible();
  await expect(page.locator(".comparison-wait")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const mobile of [false, true]) {
    test(`${theme}, ${mobile ? "mobile" : "desktop"}: responsive motion and reduced motion`, async ({ page }) => {
      const f = await fixture(page);
      f.run.status = "running";
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/runs/${f.run.id}`);
      const graphic = page.locator(".comparison-motion");
      await expect(graphic).toBeVisible();
      await expect(graphic).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator(".comparison-motion-scan").first()).toHaveCSS("animation-duration", "4s");
      expect(await graphic.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(360);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/comparison-animation-${theme}-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await graphic.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
      await expect(page.getByRole("status")).toHaveText("Analyzing comparison data");
      await page.screenshot({ path: `test-results/comparison-animation-${theme}-${mobile ? "mobile" : "desktop"}-reduced.png`, fullPage: true });
      f.run.status = "queued";
      await expect(page.getByRole("status")).toHaveText("Comparison queued");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(page.locator(".comparison-motion-table").first()).toHaveCSS("animation-name", "comparison-breathe");
    });
  }
}
