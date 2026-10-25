import { test, expect, type Page } from "@playwright/test";
import { adminUser } from "./access-fixture";
const viewer = { ...adminUser, profile: "viewer", group: { id: "viewer", name: "Finance" }, permissions: ["dashboard.read", "results.read"] };
const manager = { ...adminUser, profile: "quality_manager", permissions: adminUser.permissions.filter(p => !["connections.read", "connections.manage", "catalog.read", "datasets.manage", "access.manage", "audit.read"].includes(p)) };
async function mock(page: Page, user = adminUser) {
  const calls: string[] = [];
  const groups = [{ id: "group-1", name: "Finance", description: "Reporting", profile: "viewer", permissions: viewer.permissions, user_count: 1 }];
  const users: any[] = [];
  if (user.profile === "platform_admin") users.push({ id: "existing-user", display_name: "Existing analyst", email: "existing@example.test", group_id: "group-1", group: groups[0], is_active: true, must_change_password: false });
  await page.route("**/api/v1/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname.replace("/api/v1", ""); calls.push(`${req.method()} ${path}`);
    const send = (json: any, status = 200) => route.fulfill({ status, json });
    if (path === "/auth/refresh") return send({ access_token: "test", user });
    if (path === "/auth/me") return send(user);
    if (path === "/auth/logout" || path === "/auth/change-password") return send({ status: "ok" });
    if (path === "/overview") return send({ row_match_rate: { percentage: 100, passed: 1, evaluated: 1, coverage_percentage: 100 }, active_comparisons: 1, latest_conclusions: {}, attention: [{ comparison_id: "comparison", name: "Finance comparison", state: "difference_observed" }], recent_runs: [] });
    if (path === "/settings/quality") return send({ row_match_target_percentage: "95" });
    if (path === "/overview/comparisons") return send({ items: [], total: 0, limit: 25, offset: 0 });
    if (path === "/overview/row-match-trend") return send({ overall: [] });
    if (req.method() === "POST" && path === "/groups") { const data = req.postDataJSON(); const g = { ...data, id: "new-group", permissions: viewer.permissions, user_count: 0 }; groups.push(g); return send(g, 201); }
    if (req.method() === "POST" && path === "/users") { const data = req.postDataJSON(); const u = { ...data, id: "new-user", group: groups.find(g => g.id === data.group_id), must_change_password: true }; delete u.temporary_password; users.push(u); return send(u, 201); }
    if (req.method() === "PATCH" && path.startsWith("/groups/")) {
      const g = groups.find(g => g.id === path.split("/")[2])!; Object.assign(g, req.postDataJSON()); return send(g);
    }
    if (req.method() === "DELETE" && path.startsWith("/groups/")) {
      groups.splice(groups.findIndex(g => g.id === path.split("/")[2]), 1); return send({ status: "deleted" });
    }
    if (req.method() === "PATCH" && path.startsWith("/users/")) {
      const u = users.find(u => u.id === path.split("/")[2])!; Object.assign(u, req.postDataJSON()); u.group = groups.find(g => g.id === u.group_id); return send(u);
    }
    if (req.method() === "POST" && /\/users\/[^/]+\/(reset-password|revoke-sessions)$/.test(path)) return send({ status: "ok" });
    if (req.method() === "GET" && path === "/groups") return send({ items: groups, total: groups.length, limit: 20, offset: 0 });
    if (req.method() === "GET" && path === "/users") return send({ items: users, total: users.length, limit: 20, offset: 0 });
    if (["/runs", "/datasets", "/audit-log"].includes(path)) return send({ items: [], total: 0, limit: 20, offset: 0 });
    throw Error(`Unexpected request ${req.method()} ${path}`);
  });
  return calls;
}
for (const mobile of [false, true]) {
  test(`viewer navigation and direct-route denial ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const calls = await mock(page, viewer); await page.goto("/");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "New comparison", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Finance comparison", exact: true })).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Toggle navigation" }).click();
    const sidebar = page.locator(mobile ? ".navigation-drawer" : ".sidebar-desktop");
    await expect(sidebar.locator("nav a")).toHaveCount(2);
    await expect(sidebar.getByRole("link", { name: "Runs", exact: true })).toBeVisible();
    await page.goto("/connections"); await expect(page.getByRole("alert")).toContainText("do not have permission");
    await page.goto("/access/users"); await expect(page.getByRole("alert")).toContainText("do not have permission");
    expect(calls).not.toContain("GET /connections"); expect(calls).not.toContain("GET /users");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
test("temporary password gates every route and shows account instructions", async ({ page }) => {
  const calls = await mock(page, { ...adminUser, must_change_password: true }); await page.goto("/access/users");
  await expect(page).toHaveURL(/settings\/profile$/); await expect(page.getByRole("alert")).toContainText("Change your temporary password");
  expect(calls).not.toContain("GET /users"); await expect(page.locator(".sidebar-desktop").getByRole("region", { name: "Administration" })).toHaveCount(0);
});
test("quality manager sees registered datasets without connecting to sources", async ({ page }) => {
  const calls = await mock(page, manager); await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: "Registered datasets", exact: true })).toBeVisible();
  expect(calls).toContain("GET /datasets"); expect(calls).not.toContain("GET /connections");
  await page.goto("/access/groups"); await expect(page.getByRole("alert")).toContainText("do not have permission");
});
for (const mobile of [false, true]) {
  test(`administrator creates a group and user ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mock(page); await page.goto("/settings/groups");
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Analytics");
    await page.getByLabel("Description", { exact: true }).fill("Quality team");
    await page.getByLabel("Access profile").selectOption("quality_manager");
    await expect(page.getByRole("dialog")).toContainText("manage comparisons");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Analytics Quality team" })).toBeVisible();
    await page.goto("/settings/users"); await page.getByRole("button", { name: "New user", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Finance analyst"); await page.getByLabel("Email", { exact: true }).fill("analyst@example.test");
    await page.getByRole("combobox", { name: "Group", exact: true }).selectOption("group-1"); await page.getByLabel("Temporary password").fill("Temporary-test-password");
    await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("cell", { name: "analyst@example.test", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Active · Password change required" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/access-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
  });
}

test("settings preserve group editing/deletion and user editing, resets and session revocation", async ({ page }) => {
  const calls = await mock(page);
  await page.goto("/settings/groups");
  await expect(page.getByRole("button", { name: "Delete group", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Temporary team");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "Temporary team" });
  await row.getByRole("button", { name: "Edit group", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Renamed team");
  await page.getByRole("combobox", { name: "Access profile", exact: true }).selectOption("quality_manager");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("row").filter({ hasText: "Renamed team" }).getByRole("button", { name: "Delete group", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete group", exact: true }).getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Renamed team" })).toHaveCount(0);
  await page.goto("/settings/users");
  await page.getByRole("button", { name: "Edit user", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Updated analyst");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Updated analyst", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await page.getByLabel("Temporary password", { exact: true }).fill("Temporary-password-2026");
  await page.getByRole("dialog", { name: "Reset password", exact: true }).getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Password reset.");
  await page.getByRole("button", { name: "Revoke sessions", exact: true }).click();
  await page.getByRole("dialog", { name: "Revoke sessions", exact: true }).getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Operation completed.");
  for (const call of ["PATCH /groups/new-group", "DELETE /groups/new-group", "PATCH /users/existing-user", "POST /users/existing-user/reset-password", "POST /users/existing-user/revoke-sessions"]) expect(calls).toContain(call);
});
