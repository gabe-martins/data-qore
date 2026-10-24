import { test, expect, type Page } from "@playwright/test";
import { adminUser } from "./access-fixture";

async function setup(page: Page, user = adminUser) {
  const calls: string[] = [];
  let signedOut = false;
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    calls.push(`${route.request().method()} ${path}`);
    if (path === "/auth/refresh") return route.fulfill({ status: signedOut ? 401 : 200, json: signedOut ? {} : { access_token: "test", user } });
    if (path === "/auth/logout" || path === "/auth/change-password") { signedOut = true; return route.fulfill({ json: { status: "ok" } }); }
    if (["/runs", "/users", "/groups", "/audit-log"].includes(path)) return route.fulfill({ json: { items: [], total: 0, limit: 20, offset: 0 } });
    if (path === "/overview") return route.fulfill({ json: { row_match_rate: { passed: 0, evaluated: 0 }, active_comparisons: 0, latest_conclusions: {}, attention: [], recent_runs: [] } });
    if (path === "/settings/quality") return route.fulfill({json:{row_match_target_percentage:"95",updated_at:"2026-10-24T12:00:00Z",metric:"row_match_rate"}});
    if (path === "/overview/comparisons") return route.fulfill({json:{items:[],total:0,limit:25,offset:0}});
    if (path === "/overview/row-match-trend") return route.fulfill({ json: { overall: [] } });
    throw Error(`Unexpected request ${path}`);
  });
  return calls;
}

async function section(page: Page, name: string) {
  if (page.viewportSize()!.width <= 850) await page.getByRole("button", { name: "Toggle navigation" }).click();
  const sidebar = page.locator(page.viewportSize()!.width <= 850 ? ".navigation-drawer" : ".sidebar-desktop");
  await sidebar.getByRole("link", { name, exact: true }).click();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const theme of ["light", "dark"] as const) for (const mobile of [false, true]) {
  test(`${theme} ${mobile ? "mobile" : "desktop"}: user menu, settings sections and appearance`, async ({ page }) => {
    await setup(page);
    await page.emulateMedia({ colorScheme: theme });
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/runs");
    if (!mobile) await page.getByRole("button", { name: "Collapse sidebar" }).click();
    const trigger = page.getByRole("button", { name: "User menu", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const menu = page.getByRole("dialog", { name: "User menu", exact: true });
    await expect(menu).toContainText(adminUser.display_name);
    await expect(menu).toContainText(adminUser.email);
    await expect(menu.getByRole("link", { name: "Settings", exact: true })).toBeFocused();
    await page.screenshot({ path: `test-results/settings-${theme}-${mobile ? "mobile" : "desktop"}-user-menu.png`, fullPage: true });
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    await trigger.click(); await page.locator(".topbar .wordmark").click(); await expect(menu).toHaveCount(0);
    await trigger.click(); await menu.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar-desktop nav")).toHaveAttribute("aria-label", "Settings navigation");
    await noOverflow(page);
    await page.screenshot({ path: `test-results/settings-${theme}-${mobile ? "mobile" : "desktop"}-profile.png`, fullPage: true });
    for (const [name, path] of [["Users", "users"], ["Groups", "groups"], ["Security audit", "audit"]]) {
      await section(page, name);
      await expect(page).toHaveURL(new RegExp(`/settings/${path}$`));
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(page.getByText("No records found.")).toBeVisible();
      await noOverflow(page);
    }
    await section(page, "Appearance");
    await page.getByRole("radio", { name: theme === "light" ? "Dark" : "Light", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "light" ? "dark" : "light");
    await page.reload();
    await expect(page.getByRole("radio", { name: theme === "light" ? "Dark" : "Light", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "System", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await noOverflow(page);
    await page.screenshot({ path: `test-results/settings-${theme}-${mobile ? "mobile" : "desktop"}-appearance.png`, fullPage: true });
    if (mobile) {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      const drawer = page.getByRole("dialog", { name: "Main navigation", exact: true });
      await expect(drawer.getByRole("link", { name: "Appearance", exact: true })).toHaveAttribute("aria-current", "page");
      await page.screenshot({ path: `test-results/settings-${theme}-mobile-navigation.png`, fullPage: true });
      await page.keyboard.press("Escape"); await expect(drawer).toHaveCount(0);
    }
    await section(page, "Back to application");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    if (!mobile) {
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await expect(page.locator(".sidebar-desktop")).toHaveCSS("width", "80px");
    }
    await trigger.click(); await menu.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Theme", exact: true })).toBeVisible();
  });
}

test("legacy links redirect and forbidden sections never fetch administrative data", async ({ page }) => {
  const calls = await setup(page, { ...adminUser, profile: "viewer", permissions: ["dashboard.read", "results.read"] });
  for (const path of ["/settings", "/account"]) {
    await page.goto(path); await expect(page).toHaveURL(/settings\/profile$/);
  }
  for (const [old, current] of [["users", "users"], ["groups", "groups"], ["audit", "audit"]]) {
    await page.goto(`/access/${old}`); await expect(page).toHaveURL(new RegExp(`/settings/${current}$`));
    await expect(page.getByRole("alert")).toContainText("do not have permission");
  }
  await expect(page.locator(".settings-sidebar").getByRole("region", { name: "Administration" })).toHaveCount(0);
  expect(calls.filter(c => /GET \/(users|groups|audit-log)$/.test(c))).toEqual([]);
});

test("audit-only permission exposes only audit", async ({ page }) => {
  const calls = await setup(page, { ...adminUser, permissions: ["audit.read"] });
  await page.goto("/settings/audit");
  await expect(page.getByRole("heading", { name: "Security audit", exact: true })).toBeVisible();
  await expect(page.locator(".settings-sidebar").getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
  await expect(page.locator(".settings-sidebar").getByRole("link", { name: "Groups", exact: true })).toHaveCount(0);
  expect(calls).not.toContain("GET /users"); expect(calls).not.toContain("GET /groups");
});

test("password mismatch and mandatory password change use the existing profile form", async ({ page }) => {
  const calls = await setup(page, { ...adminUser, must_change_password: true });
  await page.goto("/settings/groups");
  await expect(page).toHaveURL(/settings\/profile$/);
  await expect(page.getByRole("alert")).toContainText("Change your temporary password");
  await expect(page.locator(".settings-sidebar").getByRole("link", { name: "Back to application" })).toHaveCount(0);
  await page.getByLabel("Current password", { exact: true }).fill("Temporary-password");
  await page.getByLabel("New password", { exact: true }).fill("New-test-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Other-test-password");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Passwords do not match." })).toBeVisible();
  expect(calls).not.toContain("POST /auth/change-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("New-test-password");
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(calls).toContain("POST /auth/change-password"); expect(calls).not.toContain("GET /groups");
});

for (const scheme of ["light", "dark"] as const) for (const mobile of [false, true]) {
  test(`${scheme} ${mobile ? "mobile" : "desktop"}: theme submenu shares appearance and persists`, async ({ page }) => {
    const calls = await setup(page);
    await page.emulateMedia({ colorScheme: scheme });
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/runs");
    await expect(page.getByRole("heading", { name: "Run history", exact: true })).toBeVisible();
    const trigger = page.getByRole("button", { name: "User menu", exact: true });
    const menu = page.getByRole("dialog", { name: "User menu", exact: true });
    await trigger.click();
    await menu.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(menu.getByRole("button", { name: "Back", exact: true })).toBeFocused();
    await expect(menu.getByRole("radio", { name: "System", exact: true })).toBeChecked();
    await page.screenshot({ path: `test-results/user-theme-${scheme}-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await menu.getByRole("radio", { name: "Light", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await menu.getByRole("radio", { name: "Dark", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.keyboard.press("Escape");
    await expect(menu.getByRole("button", { name: "Theme", exact: true })).toBeFocused();
    await expect(menu.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await menu.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(menu.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    await menu.getByRole("button", { name: "Back", exact: true }).click();
    await expect(menu.getByRole("button", { name: "Theme", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused(); await expect(menu).toHaveCount(0);
    await page.reload(); await trigger.click();
    await expect(menu.getByRole("button", { name: "Theme", exact: true })).toBeVisible();
    await menu.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(menu.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    await menu.getByRole("radio", { name: "System", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await page.emulateMedia({ colorScheme: scheme === "light" ? "dark" : "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme === "light" ? "dark" : "light");
    await menu.getByRole("button", { name: "Back", exact: true }).click();
    await menu.getByRole("link", { name: "Settings", exact: true }).click();
    await section(page, "Appearance");
    await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await trigger.click(); await menu.getByRole("button", { name: "Theme", exact: true }).click();
    await expect(menu.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
    await menu.getByRole("radio", { name: "Light", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    await expect(page.getByRole("main").getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
    await noOverflow(page);
    expect(calls.filter(c => c.startsWith("POST") && c !== "POST /auth/refresh")).toEqual([]);
  });
}
