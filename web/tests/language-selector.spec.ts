import { test, expect } from "@playwright/test";
import { languageFixture } from "./language-fixture";

for (const theme of ["light", "dark"] as const) for (const mobile of [false, true]) {
  test(`language selector: ${theme}, ${mobile ? "mobile" : "desktop"} flags, selection and keyboard`, async ({ page }) => {
    const calls = await languageFixture(page);
    await page.emulateMedia({ colorScheme: theme });
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/language");
    const choices = page.getByRole("group", { name: "Language", exact: true });
    const english = page.getByRole("radio", { name: "English", exact: true });
    const portuguese = page.getByRole("radio", { name: "Português (Brasil)", exact: true });
    await expect(choices.getByRole("radio")).toHaveCount(2);
    await expect(english).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const country of ["us", "br"]) {
      const flag = choices.locator(`img[src="/flags/${country}.svg"]`);
      await expect(flag).toHaveAttribute("alt", "");
      await expect(flag).toHaveAttribute("aria-hidden", "true");
      await expect.poll(() => flag.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
    await expect(page.locator(".language-option:has(input:checked) .language-option-indicator svg")).toHaveCount(1);
    await page.screenshot({ path: `test-results/language-selector-${theme}-${mobile ? "mobile" : "desktop"}-en.png`, fullPage: true });
    // The whole row, including its flag, is a selection target.
    await page.locator('.language-option:has(input[value="pt-BR"])').click({ position: { x: 30, y: 40 } });
    await expect(portuguese).toBeChecked();
    await expect(english).not.toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
    await expect(page.getByText("Estados Unidos", { exact: true })).toBeVisible();
    await expect(page.getByText("Brasil", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".language-option").first().evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `test-results/language-selector-${theme}-${mobile ? "mobile" : "desktop"}-pt.png`, fullPage: true });
    await portuguese.focus();
    await page.keyboard.press("ArrowUp");
    await expect(english).toBeChecked();
    await expect(english).toBeFocused();
    await expect(page.locator('.language-option:has(input[value="en-US"])')).toHaveCSS("outline-style", "solid");
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    expect(calls.filter(c => c.method !== "GET" && c.path !== "/auth/refresh")).toEqual([]);
  });
}
