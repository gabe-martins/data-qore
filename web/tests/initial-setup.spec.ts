import { test, expect } from "@playwright/test";
import { languageFixture } from "./language-fixture";
import { adminUser } from "./access-fixture";

for (const locale of ["en-US", "pt-BR"]) for (const mobile of [false, true]) {
  test(`first administrator setup and subsequent login ${locale} ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    await languageFixture(page);
    await page.addInitScript(locale => localStorage.setItem("dataqore.ui.language", locale), locale);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    let created = false, claims = 0;
    await page.route("**/api/v1/auth/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith("/refresh")) return route.fulfill({ status: 401, json: {} });
      if (path.endsWith("/setup") && request.method() === "GET") return route.fulfill({ json: { required: !created } });
      if (path.endsWith("/setup") && request.method() === "POST") {
        claims++;
        expect(request.postDataJSON()).toEqual({ display_name: "First administrator", email: "first@example.test", password: "first-administrator-password" });
        created = true;
        return route.fulfill({ status: 201, json: { access_token: "first-session", user: adminUser } });
      }
      return route.fallback();
    });
    const pt = locale === "pt-BR";
    await page.goto("/");
    await expect(page.getByRole("heading", { name: pt ? "Crie seu administrador" : "Create your administrator" })).toBeVisible();
    await page.getByLabel(pt ? "Nome" : "Name", { exact: true }).fill("First administrator");
    await page.getByLabel(pt ? "E-mail" : "Email", { exact: true }).fill("first@example.test");
    await page.getByLabel(pt ? "Senha" : "Password", { exact: true }).fill("first-administrator-password");
    await page.getByLabel(pt ? "Confirme a senha" : "Confirm password", { exact: true }).fill("another-password-to-reject");
    await page.getByRole("button", { name: pt ? "Criar administrador" : "Create administrator" }).click();
    await expect(page.getByRole("alert")).toContainText(pt ? "As senhas não coincidem" : "Passwords do not match");
    expect(claims).toBe(0);
    await page.getByLabel(pt ? "Confirme a senha" : "Confirm password", { exact: true }).fill("first-administrator-password");
    await page.getByRole("button", { name: pt ? "Criar administrador" : "Create administrator" }).click();
    await expect(page.getByRole("heading", { name: pt ? "Visão geral" : "Overview", exact: true })).toBeVisible();
    expect(claims).toBe(1);
    await page.reload();
    await expect(page.getByRole("heading", { name: pt ? "Boas-vindas" : "Welcome back" })).toBeVisible();
    await expect(page.getByLabel(pt ? "Confirme a senha" : "Confirm password")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
