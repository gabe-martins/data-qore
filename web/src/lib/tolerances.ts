// Decimal strings stay exact, including API values in scientific notation.
const DECIMAL = /^\+?(?:(\d+)(?:[.,](\d*))?|[.,](\d+))(?:[eE]([+-]?\d+))?$/;

export function normalizeTolerance(value: string): string {
  const text = value.trim();
  if (!DECIMAL.test(text))
    throw new Error("Enter a non-negative decimal number. Use a dot or comma as the decimal separator, without thousands separators.");
  return text.replace(",", ".").replace(/^\+/, "");
}

function shiftDecimal(value: string, places: number): string {
  const text = normalizeTolerance(value);
  const match = DECIMAL.exec(text)!;
  const fraction = match[2] ?? match[3] ?? "";
  let digits = ((match[1] ?? "0") + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const trimmed = digits.replace(/0+$/, "");
  const power = BigInt(match[4] ?? "0") - BigInt(fraction.length) +
    BigInt(places) + BigInt(digits.length - trimmed.length);
  digits = trimmed;
  const position = BigInt(digits.length) + power;
  // Bound zero padding for extreme existing exponents; scientific notation is exact.
  if (position > 1000n || position < -1000n)
    return digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (position - 1n).toString();
  if (position <= 0n) return "0." + "0".repeat(-Number(position)) + digits;
  if (position >= BigInt(digits.length))
    return digits + "0".repeat(Number(position - BigInt(digits.length)));
  const index = Number(position);
  return digits.slice(0, index) + "." + digits.slice(index);
}

export const fractionToPercent = (value: string) => shiftDecimal(value, 2);
export const percentToFraction = (value: string) => shiftDecimal(value, -2);
