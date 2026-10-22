// Decimal strings stay exact, including API values in scientific notation.
const DECIMAL = /^\+?(?:(\d+)(?:[.,](\d*))?|[.,](\d+))(?:[eE]([+-]?\d+))?$/;

export function normalizeTolerance(value: string): string {
  const text = value.trim();
  if (!DECIMAL.test(text))
    throw new Error("Enter a non-negative decimal number. Use a dot or comma as the decimal separator, without thousands separators.");
  return text.replace(",", ".").replace(/^\+/, "");
}
