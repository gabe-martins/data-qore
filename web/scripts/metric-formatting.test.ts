import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPercent } from "../src/lib/metricFormatting.ts";
test("a rounded positive population divergence never appears as a healthy zero", () => {
  assert.equal(
    formatPercent({
      percentage: "0.0000",
      numerator: 1,
      denominator: 10_000_000,
    }),
    "<0.0001%",
  );
  assert.equal(
    formatPercent({
      percentage: "0.0000",
      numerator: 0,
      denominator: 10_000_000,
    }),
    "0%",
  );
  assert.equal(formatPercent("0.0001"), "0.0001%");
  assert.equal(formatPercent("99.1000"), "99.1%");
  assert.equal(formatPercent(null), "Not evaluated");
  assert.equal(formatPercent(Infinity), "Unavailable");
});
