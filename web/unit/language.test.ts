import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogs, translate, pluralText, reasonText, numberText, dateTimeText, decimalText, isLocale } from "../src/i18n/core.ts";
import { formatPercent } from "../src/lib/metricFormatting.ts";
import { errorText } from "../src/i18n/errors.ts";
test("catalogs have matching keys, interpolation and translated dynamic diagnostics", () => {
  assert.deepEqual(Object.keys(catalogs["en-US"]).sort(), Object.keys(catalogs["pt-BR"]).sort());
  for (const [key, value] of Object.entries(catalogs["pt-BR"])) {
    assert.ok(value.trim(), key);
    assert.deepEqual([...key.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), [...value.matchAll(/\{\w+\}/g)].map(m => m[0]).sort(), key);
  }
  assert.equal(translate("Step {0} of 4 · {1}", "pt-BR", {0: 2, 1: "Colunas"}), "Etapa 2 de 4 · Colunas");
  assert.equal(translate(" Source A ", "pt-BR"), " Fonte A ");
  assert.equal(reasonText("Source 1: reads use best effort; separate queries may observe different states.", "pt-BR"), "Fonte 1: as leituras usam o melhor esforço; consultas separadas podem observar estados diferentes.");
  assert.equal(reasonText("3 unpaired or incompatible column pairs. This is a technical diagnostic, not a quality score.", "pt-BR"), "3 pares de colunas sem correspondência ou incompatíveis. Este é um diagnóstico técnico, não uma nota de qualidade.");
  assert.equal(pluralText(1, "pt-BR", "Column", "columns"), "Coluna");
  assert.equal(pluralText(2, "pt-BR", "Column", "columns"), "colunas");
  assert.equal(isLocale("fr-FR"), false);
});
test("percentages preserve zero, precision, missing values and counts in both languages", () => {
  assert.equal(formatPercent("99.1"), "99.1%");
  assert.equal(formatPercent("99.1", "pt-BR"), "99,1%");
  assert.equal(formatPercent(null, "pt-BR"), "Não avaliado");
  assert.equal(formatPercent("NaN", "pt-BR"), "Indisponível");
  assert.equal(formatPercent(0, "pt-BR"), "0%");
  assert.equal(formatPercent("0.00001", "pt-BR"), "<0,0001%");
  assert.equal(formatPercent({percentage: "0", numerator: 1, denominator: 10000000}, "pt-BR"), "<0,0001%");
  assert.equal(formatPercent(200, "pt-BR"), "200%");
  assert.equal(numberText(1200000, "pt-BR"), "1.200.000");
  assert.equal(decimalText("0.00000000000000000001", "pt-BR"), "0,00000000000000000001");
  assert.equal(dateTimeText("2026-10-24T12:00:00Z", "pt-BR", {timeZone: "America/Sao_Paulo"}), "24/10/2026, 09:00:00");
});
test("known errors translate while English and raw detail strings remain unchanged", () => {
  const message = "Original driver failure";
  assert.equal(errorText("source_connection_timeout", message, "en-US"), message);
  assert.match(errorText("source_connection_timeout", message, "pt-BR"), /tempo limite/);
  assert.equal(errorText(null, "Passwords do not match.", "pt-BR"), "As senhas não coincidem.");
  assert.match(errorText("unknown_driver", message, "pt-BR"), /detalhes técnicos/);
});
test("both manual documents share index destinations and are self-contained", () => {
  const pt = readFileSync(new URL("../src/content/user-manual.html", import.meta.url), "utf8");
  const en = readFileSync(new URL("../src/content/user-manual.en-US.html", import.meta.url), "utf8");
  const ids = (s: string) => [...s.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(ids(pt), ids(en));
  for (const html of [pt, en]) {
    assert.doesNotMatch(html, /<script|<link|<iframe|<img/i);
    for (const anchor of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids(html).includes(anchor[1]));
  }
});

test("every literal translation key used by the interface exists in both catalogs", async () => {
  const ts = await import("typescript");
  const { readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname;
  function files(dir: string): string[] { return readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]); }
  for (const file of files(root).filter(file => file.endsWith(".tsx") && !file.includes("/i18n/"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: import("typescript").Node) {
      if (ts.isCallExpression(node) && ["t", "tr"].includes(node.expression.getText(source)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text.trim();
        assert.ok(Object.hasOwn(catalogs["pt-BR"], key), `${file}: missing ${key}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
