import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTolerance } from "../src/lib/tolerances.ts";
test("numeric tolerance strings retain exact precision", () => {
  assert.equal(
    normalizeTolerance("+0,00000000000000000001"),
    "0.00000000000000000001",
  );
  assert.equal(normalizeTolerance("1e-40"), "1e-40");
  for (const value of ["-1", "NaN", "Infinity", "1,2,3"])
    assert.throws(() => normalizeTolerance(value));
});
