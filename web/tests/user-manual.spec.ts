import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { adminUser } from "./access-fixture";

async function authenticate(page: Page, viewer = false, temporary = false) {
  const requests: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    requests.push(`${route.request().method()} ${path}`);
    if (path === "/auth/refresh") {
      return route.fulfill({ json: { access_token: "test", user: {
        ...adminUser,
        profile: viewer ? "viewer" : adminUser.profile,
        permissions: viewer ? ["dashboard.read", "results.read"] : adminUser.permissions,
        must_change_password: temporary,
      } } });
    }
    throw Error(`The manual must not fetch operational data: ${path}`);
  });
  return requests;
}

for (const mobile of [false, true]) {
  test(`manual navigation, anchors and theme on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    const requests = await authenticate(page, true);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/settings/profile");
    if (mobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
    const sidebar = page.locator(mobile ? ".navigation-drawer" : ".sidebar-desktop");
    await sidebar.getByRole("link", { name: "Manual de uso", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/manual$/);
    await expect(page.getByRole("heading", { name: "Manual de uso", exact: true })).toBeVisible();
    await expect(page).toHaveTitle("Manual de uso · DataQore");
    const index = page.getByRole("navigation", { name: "Índice do manual" });
    await expect(index.getByRole("link")).toHaveCount(17);
    expect(await page.locator(".user-manual").evaluate(root => {
      const ids = Array.from(root.querySelectorAll("[id]")).map(el => el.id);
      return ids.length === new Set(ids).size && Array.from(root.querySelectorAll('a[href^="#"]')).every(link =>
        !!root.querySelector(link.getAttribute("href")!),
      );
    })).toBe(true);
    await index.getByRole("link", { name: "As cinco métricas" }).click();
    await expect(page).toHaveURL(/#manual-metricas$/);
    const heading = page.getByRole("heading", { name: "As cinco métricas: fórmula, escopo e interpretação" });
    await expect(heading).toBeInViewport();
    await page.reload();
    await expect(heading).toBeInViewport();
    const table = page.getByRole("region", { name: "Tabela das cinco métricas", exact: true });
    for (const metric of ["Row Count Match", "Key Coverage", "Duplicate Key Rate", "Row Match Rate", "Column Match Rate"])
      await expect(table.getByRole("rowheader", { name: metric, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.locator("#manual-inicio").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/manual-${mobile ? "mobile" : "desktop"}-${theme}.png` });
      expect(await page.locator(".user-manual").evaluate(el => {
        const text = getComputedStyle(el).color;
        const surface = getComputedStyle(el.querySelector(".manual-hero")!).backgroundColor;
        return text !== surface;
      })).toBe(true);
    }
    await page.locator("#manual-metricas").evaluate(el => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `test-results/manual-metrics-${mobile ? "mobile" : "desktop"}.png` });
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".topbar")).toBeHidden();
    await expect(page.locator(".manual-tools")).toBeHidden();
    expect(await page.locator(".user-manual details p").first().evaluate(el => getComputedStyle(el).display)).toBe("block");
    expect(await page.locator(".user-manual details p").first().evaluate(el => el.checkVisibility({ contentVisibilityAuto: true }))).toBe(true);
    expect(requests.every(value => value === "POST /auth/refresh")).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("download is a complete standalone HTML document with working index and no external resources", async ({ page, context }) => {
  await authenticate(page);
  await page.goto("/settings/manual");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar HTML", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("dataqore-manual-de-uso.html");
  const html = await readFile((await download.path())!, "utf8");
  expect(html).toMatch(/^<!doctype html>/);
  const standalone = await context.newPage();
  const unexpected: string[] = [];
  await standalone.route("**/*", route => {
    if (route.request().isNavigationRequest()) return route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
    unexpected.push(route.request().url());
    return route.abort();
  });
  await standalone.goto("http://manual.test/");
  await expect(standalone.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(standalone.getByRole("heading", { name: "Manual de uso", exact: true })).toBeVisible();
  await standalone.getByRole("link", { name: "Settings e administração", exact: true }).click();
  await expect(standalone.getByRole("heading", { name: "Settings e administração", exact: true })).toBeInViewport();
  await standalone.setViewportSize({ width: 390, height: 844 });
  expect(await standalone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await standalone.screenshot({ path: "test-results/manual-standalone-mobile.png" });
  expect(await standalone.locator("script, link[rel=stylesheet], iframe, img").count()).toBe(0);
  expect(unexpected).toEqual([]);
});

test("temporary password still requires changing credentials before opening the manual", async ({ page }) => {
  await authenticate(page, false, true);
  await page.goto("/settings/manual");
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(page.getByRole("alert")).toContainText("Change your temporary password");
  await expect(page.locator(".sidebar-desktop").getByRole("link", { name: "Manual de uso", exact: true })).toHaveCount(0);
});
