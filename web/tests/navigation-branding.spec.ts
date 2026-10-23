import { adminUser } from "./access-fixture";
import { test, expect, type Page, type Locator } from "@playwright/test";

async function setup(page: Page) {
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/auth/refresh") {
      return route.fulfill({ json: { access_token: "test", user: adminUser } });
    }
    if (path === "/api/v1/runs") return route.fulfill({ json: { items: [], total: 0, limit: 20, offset: 0 } });
    throw new Error(`Unexpected request: ${path}`);
  });
}

async function cleanNavigation(sidebar: Locator) {
  await expect(sidebar.locator("img")).toHaveCount(0);
  await expect(sidebar.getByText("DataQore", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Account", exact: true })).toHaveCount(0);
  await expect(sidebar.locator("nav a")).toHaveCount(9);
  await expect(sidebar.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function fullWidthHeader(page: Page) {
  const header = await page.locator(".topbar").boundingBox();
  expect(header?.x).toBe(0);
  expect(header?.width).toBe(page.viewportSize()!.width);
  expect(header?.y).toBe(0);
}

async function sidebarBelowHeader(page: Page) {
  await fullWidthHeader(page);
  const header = await page.locator(".topbar").boundingBox();
  const sidebar = await page.locator(".sidebar-desktop").boundingBox();
  expect(sidebar?.y).toBe(header!.height);
  const content = await page.locator("main.page").boundingBox();
  expect(content!.x).toBe(sidebar!.width);
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: single brand, circular accessible profile and compact sidebar`, async ({ page }) => {
    await setup(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Run history", exact: true })).toBeVisible();
    const header = page.locator(".topbar");
    const logo = header.getByRole("img", { name: "DataQore", exact: true });
    await expect(logo).toHaveCount(1);
    await expect(page.locator(".product-title img")).toHaveAttribute("src", `/branding/dataqore-logo${theme === "dark" ? "-inverse" : ""}.svg`);
    await expect(logo).toHaveCSS("width", "138px");
    await expect(header).not.toContainText("ADQ");
    await expect(header).not.toContainText("DataQore Administrator");
    await expect(header.locator(".profile-link span")).toHaveCount(0);
    const account = header.getByRole("link", { name: "Account", exact: true });
    await expect(account).toHaveCSS("width", "40px");
    await expect(account).toHaveCSS("height", "40px");
    await expect(account).toHaveCSS("border-radius", "50%");
    const sidebar = page.locator(".sidebar-desktop");
    await cleanNavigation(sidebar);
    await noOverflow(page);
    await sidebarBelowHeader(page);
    // The header remains above the sidebar when the document scrolls.
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.id = "scroll-fixture";
      spacer.style.height = "1500px";
      document.querySelector("main")!.append(spacer);
      window.scrollTo(0, 300);
    });
    await sidebarBelowHeader(page);
    await page.evaluate(() => { document.getElementById("scroll-fixture")!.remove(); window.scrollTo(0, 0); });
    await page.screenshot({ path: `test-results/navigation-branding-${theme}-desktop.png`, fullPage: true });
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await expect(sidebar).toHaveCSS("width", "80px");
    await cleanNavigation(sidebar);
    await page.reload();
    await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run history", exact: true })).toBeVisible();
    await noOverflow(page);
    await sidebarBelowHeader(page);
    await page.screenshot({ path: `test-results/navigation-branding-${theme}-compact.png`, fullPage: true });
    // The full-width header precedes the sidebar in keyboard navigation.
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(account).toBeFocused();
    await expect(account).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expect(page.getByText("DataQore Administrator", { exact: true })).toBeVisible();
  });

  test(`${theme}: mobile header and drawer keep navigation and focus behavior`, async ({ page }) => {
    await setup(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Run history", exact: true })).toBeVisible();
    const header = page.locator(".topbar");
    await expect(header.locator(".product-title img")).toHaveCSS("width", "110px");
    await expect(header.locator("img")).toHaveCount(1);
    await expect(header).not.toContainText("ADQ");
    await expect(header).not.toContainText("DataQore Administrator");
    await noOverflow(page);
    await fullWidthHeader(page);
    await page.screenshot({ path: `test-results/navigation-branding-${theme}-mobile.png`, fullPage: true });
    const toggle = page.getByRole("button", { name: "Toggle navigation", exact: true });
    await toggle.click();
    const drawer = page.getByRole("dialog", { name: "Main navigation", exact: true });
    await cleanNavigation(drawer);
    await expect(drawer.getByRole("button", { name: "Theme", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/navigation-branding-${theme}-drawer.png`, fullPage: true });
    await drawer.getByRole("button", { name: "Close navigation", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Tab");
    const account = header.getByRole("link", { name: "Account", exact: true });
    await expect(account).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await noOverflow(page);
  });
}
