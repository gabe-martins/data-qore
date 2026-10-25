import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { languageFixture } from "./language-fixture";
const key = "dataqore.ui.language";
async function saved(page: Page, locale: string) { await page.addInitScript(({ key, locale }) => localStorage.setItem(key, locale), { key, locale }); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

test("English default ignores device locale and setting persists through reload and logout", async ({ page }) => {
  const calls = await languageFixture(page);
  await page.goto("/settings/language");
  await expect(page.getByRole("radio", { name: "English", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "Português (Brasil)", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByRole("heading", { name: "Idioma", exact: true }).first()).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("pt-BR");
  await page.reload();
  await expect(page.getByRole("radio", { name: "Português (Brasil)", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Menu do usuário", exact: true }).click();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Boas-vindas" })).toBeVisible();
  await expect(page.getByLabel("Senha", { exact: true })).toBeVisible();
  expect(calls.filter(c => c.method !== "GET" && !["/auth/refresh", "/auth/logout"].includes(c.path))).toEqual([]);
});

for (const locale of ["en-US", "pt-BR"] as const) for (const mobile of [false, true]) {
  test(`${locale} ${mobile ? "mobile" : "desktop"}: all pages, wizard and administrative dialogs`, async ({ page }) => {
    const calls = await languageFixture(page);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await saved(page, locale);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const pt = locale === "pt-BR";
    for (const [path, english, portuguese] of [
      ["/", "Overview", "Visão geral"], ["/connections", "Connections", "Conexões"], ["/catalog", "Catalog", "Catálogo"], ["/datasets/left", "left", "left"], ["/comparisons", "Comparisons", "Comparações"], ["/runs", "Run history", "Histórico de execuções"], ["/runs/run-1", "Comparison result", "Resultado da comparação"], ["/schedules", "Schedules", "Agendamentos"], ["/settings/profile", "Profile", "Perfil"], ["/settings/appearance", "Appearance", "Aparência"], ["/settings/quality", "Quality target", "Meta de qualidade"], ["/settings/users", "Users", "Usuários"], ["/settings/groups", "Groups", "Grupos"], ["/settings/audit", "Security audit", "Auditoria de segurança"],
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: pt ? portuguese : english, exact: true }).first()).toBeVisible();
      await noOverflow(page);
    }
    await page.goto("/connections"); await page.getByRole("button", { name: pt ? "Nova conexão" : "New connection", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(pt ? "Tipo de banco de dados" : "Database type");
    await page.getByLabel(pt ? "Tipo de banco de dados" : "Database type").selectOption("databricks");
    await expect(page.getByRole("dialog")).toContainText(pt ? "entidade de serviço" : "service principal");
    await page.getByRole("button", { name: pt ? "Fechar" : "Close", exact: true }).click();
    await page.goto("/comparisons/new");
    await page.getByLabel(pt ? "Nome" : "Name", { exact: true }).fill("Never translate this name");
    await page.getByLabel(pt ? "Fonte A" : "Source A", { exact: true }).selectOption("left");
    await page.getByLabel(pt ? "Fonte B" : "Source B", { exact: true }).selectOption("right");
    await page.getByRole("button", { name: pt ? "Próximo" : "Next", exact: true }).click();
    await expect(page.locator(".page-title")).toContainText(pt ? "Etapa 2 de 4 · Colunas e fusos horários" : "Step 2 of 4 · Columns and timezones");
    await expect(page.getByRole("heading", { name: pt ? "Colunas e interpretação de timestamps" : "Columns and timestamp interpretation", exact: true })).toBeVisible();
    await page.getByRole("button", { name: pt ? "Próximo" : "Next", exact: true }).click();
    await expect(page.getByRole("heading", { name: pt ? "Tolerâncias numéricas" : "Numeric tolerances", exact: true })).toBeVisible();
    await expect(page.getByText(pt ? "Zero exige igualdade numérica exata." : "Zero means exact numeric equality.", { exact: false })).toBeVisible();
    await page.goto("/schedules"); await page.getByRole("button", { name: pt ? "Novo agendamento" : "New schedule", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(pt ? "Próximas ocorrências" : "Next occurrences");
    await page.getByRole("button", { name: pt ? "Fechar" : "Close", exact: true }).click();
    await page.goto("/settings/groups"); await page.getByRole("button", { name: pt ? "Novo grupo" : "New group", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(pt ? "Perfil de acesso" : "Access profile");
    await noOverflow(page);
    await page.screenshot({ path: `test-results/language-${locale}-${mobile ? "mobile" : "desktop"}.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await noOverflow(page);
    await page.screenshot({ path: `test-results/language-${locale}-${mobile ? "mobile" : "desktop"}-dark.png` });
    expect(errors).toEqual([]);
    expect(calls.filter(c => !["GET"].includes(c.method) && !["/auth/refresh", "/schedules/preview"].includes(c.path))).toEqual([]);
  });
}

test("Portuguese quality includes translated engine explanations, precise metrics and unchanged source values", async ({ page }) => {
  await languageFixture(page); await saved(page, "pt-BR");
  await page.goto("/comparisons/comparison-1?run_id=run-1");
  await expect(page.getByRole("heading", { name: "English source name", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Qualidade da comparação", exact: true })).toBeVisible();
  await expect(page.locator(".quality-headline strong").first()).toHaveText("99,1%");
  await expect(page.getByText("Amostra capturada: esta tabela não representa toda a população da fonte.")).toBeVisible();
  await expect(page.locator(".quality-headline")).toContainText("avaliadas");
  await expect(page.locator(".quality-dimension-detail")).toContainText("Correspondência de linhas e colunas conforme as regras congeladas");
  await page.locator(".metric-explanation").first().getByText("Detalhes do cálculo", { exact: true }).click();
  await expect(page.locator(".metric-explanation").first()).toContainText("Row Match Rate");
  await expect(page.locator(".metric-explanation").first()).toContainText("100 × linhas iguais / posições de linha avaliadas");
  await page.getByText("Consistência e limitações", { exact: true }).click();
  await expect(page.getByText("Fonte 1: as leituras usam o melhor esforço; consultas separadas podem observar estados diferentes.")).toBeVisible();
  await page.getByRole("button", { name: "Inspecionar registro", exact: true }).click();
  await expect(page.locator(".evidence-cells")).toContainText("Overview");
  await expect(page.locator(".evidence-cells")).toContainText("Espaços em branco");
  await expect(page.locator(".evidence-cells")).not.toContainText("Visão geral");
  await page.getByLabel("Chave exata (array JSON; strings preservam a precisão)").fill('["123"]');
  await page.getByRole("button", { name: "Buscar chave", exact: true }).click();
  await noOverflow(page);
  await page.screenshot({ path: "test-results/language-quality-pt-BR.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: "test-results/language-quality-mobile-pt-BR.png" });
});

test("cross-tab changes update open forms, cached results and filters without writes or losing draft", async ({ page, context }) => {
  const calls = await languageFixture(page);
  await page.goto("/comparisons/new");
  await page.getByLabel("Name", { exact: true }).fill("Preserved draft");
  await page.getByLabel("Source A", { exact: true }).selectOption("left");
  const other = await context.newPage(); await languageFixture(other); await other.goto("/settings/language");
  await other.getByRole("radio", { name: "Português (Brasil)", exact: true }).check();
  await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("Preserved draft");
  await expect(page.getByLabel("Fonte A", { exact: true })).toHaveValue("left");
  await page.goto("/comparisons/comparison-1?run_id=run-1");
  await page.getByLabel("Estado do registro", { exact: true }).selectOption("different");
  await other.getByRole("radio", { name: "English", exact: true }).check();
  await expect(page.getByRole("heading", { name: "Comparison Quality", exact: true })).toBeVisible();
  await expect(page.getByLabel("Record state", { exact: true })).toHaveValue("different");
  await expect(page).toHaveURL(/run_id=run-1/);
  expect(calls.filter(c => c.method !== "GET" && c.path !== "/auth/refresh")).toEqual([]);
});

test("temporary passwords permit language settings and continue blocking operational access", async ({ page }) => {
  await languageFixture(page, true);
  await page.goto("/settings/language");
  await page.getByRole("radio", { name: "Português (Brasil)", exact: true }).check();
  await page.goto("/comparisons");
  await expect(page).toHaveURL(/settings\/profile$/);
  await expect(page.getByRole("alert")).toContainText("Altere sua senha temporária");
});

test("invalid preference and blocked storage fall back to English with in-memory switching", async ({ page }) => {
  await languageFixture(page); await saved(page, "fr-FR");
  await page.goto("/settings/language");
  await expect(page.getByRole("radio", { name: "English", exact: true })).toBeChecked();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error("Blocked storage"); }; });
  await page.getByRole("radio", { name: "Português (Brasil)", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
});

test("localized errors retain technical message, code and request ID; metrics never become zero", async ({ page }) => {
  await languageFixture(page); await saved(page, "pt-BR");
  await page.route("**/api/v1/connections?**", route => route.fulfill({ status: 503, json: { code: "source_connection_timeout", message: "Original driver detail", request_id: "request-42" } }));
  await page.goto("/connections");
  await expect(page.getByRole("alert")).toContainText("A conexão com a fonte excedeu o tempo limite.");
  await expect(page.getByRole("alert")).toContainText("request-42");
  await page.getByText("Detalhes técnicos", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("source_connection_timeout: Original driver detail");
});


test("Portuguese decimal input preserves API fractions and numeric target values", async ({ page }) => {
  const calls = await languageFixture(page); await saved(page, "pt-BR");
  await page.goto("/comparisons/new");
  await page.getByLabel("Nome", {exact: true}).fill("Precision check");
  await page.getByLabel("Fonte A", {exact: true}).selectOption("left");
  await page.getByLabel("Fonte B", {exact: true}).selectOption("right");
  await page.getByRole("button", {name: "Próximo", exact: true}).click();
  await page.getByRole("button", {name: "Próximo", exact: true}).click();
  await page.getByLabel("Tolerância absoluta", {exact: true}).fill("0,00000000000000000001");
  await page.getByLabel("Tolerância relativa (fração)", {exact: true}).fill("0,01");
  await page.getByRole("button", {name: "Revisão", exact: true}).click();
  await expect(page.getByRole("heading", {name: "Revisão", exact: true})).toBeVisible();
  const preview = calls.find(c => c.path === "/comparisons/preview")!.body;
  expect(preview.absolute_tolerance).toBe("0.00000000000000000001");
  expect(preview.relative_tolerance).toBe("0.01");
  expect(preview.left_dataset_id).toBe("left");
  await page.goto("/settings/quality");
  await page.getByLabel("Correspondência mínima de linhas (%)").fill("97,25");
  await page.getByRole("button", {name: "Salvar meta", exact: true}).click();
  await expect(page.getByRole("status")).toHaveText("Meta de qualidade salva.");
  expect(calls.find(c => c.method === "PATCH" && c.path === "/settings/quality")!.body).toEqual({row_match_target_percentage: 97.25});
});

test("JSON exports preserve technical keys and business values in Portuguese", async ({ page }) => {
  await languageFixture(page); await saved(page, "pt-BR");
  await page.goto("/comparisons/comparison-1?run_id=run-1");
  const evidencePending = page.waitForEvent("download");
  await page.getByRole("button", {name: "Baixar registros capturados", exact: true}).click();
  const evidence = JSON.parse(await readFile((await (await evidencePending).path())!, "utf8"));
  expect(evidence.records[0]).toEqual({key:["123"],state:"different",left:{Notes:"Overview"},right:{Notes:" "}});
  await page.goto("/runs/run-1");
  const resultPending = page.waitForEvent("download");
  await page.getByRole("button", {name: "Baixar resultado", exact: true}).click();
  const result = JSON.parse(await readFile((await (await resultPending).path())!, "utf8"));
  expect(result.conclusion).toBe("difference_observed");
  expect(result.result.metrics.row_match_rate.percentage).toBe("99.1");
  expect(result.result.metrics.row_match_rate.numerator).toBe(991);
});
