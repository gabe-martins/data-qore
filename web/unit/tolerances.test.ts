import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTolerance, fractionToPercent, percentToFraction } from "../src/lib/tolerances.ts";

test("percentage conversion is exact and does not cap percentages at 100", () => {
  for (const [percent, fraction] of [
    ["0", "0"], ["1", "0.01"], ["0.125", "0.00125"], ["150", "1.5"],
    ["0.00000000000000000001", "0.0000000000000000000001"],
    ["12345678901234567890.1234567890123456789", "123456789012345678.901234567890123456789"],
  ]) {
    assert.equal(percentToFraction(percent), fraction);
    assert.equal(fractionToPercent(fraction), percent);
  }
});
test("comma/dot decimals, scientific API values and absolute units are preserved", () => {
  assert.equal(normalizeTolerance(" 0,50 "), "0.50");
  assert.equal(normalizeTolerance("0.50"), "0.50");
  assert.equal(percentToFraction("1,5"), "0.015");
  assert.equal(fractionToPercent("1E-2"), "1");
  assert.equal(fractionToPercent("1.2300e+2"), "12300");
  assert.equal(percentToFraction(".5"), "0.005");
  assert.equal(fractionToPercent("0E-1000000"), "0");
  assert.equal(fractionToPercent("1E-1000000"), "1e-999998");
  assert.equal(percentToFraction("1E+1000000"), "1e999998");
  assert.equal(percentToFraction(fractionToPercent("1E-1000000")), "1e-1000000");
});
test("empty, negative, infinite and malformed decimals are rejected", () => {
  for (const input of ["", " ", "-1", "-0", "NaN", "Infinity", "1%", "1,000.5", "1.000,5", "1 000", "1_000", "1,2,3", "1e", "0x10"])
    for (const convert of [normalizeTolerance, percentToFraction, fractionToPercent])
      assert.throws(() => convert(input), /non-negative decimal/);
});
