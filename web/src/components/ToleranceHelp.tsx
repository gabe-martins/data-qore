import { HelpTip } from "./HelpTip";

export function ToleranceHelp({ relative = false }: { relative?: boolean }) {
  return <HelpTip label={relative ? "About relative tolerance" : "About absolute tolerance"}>
    {relative
      ? "A proportional difference based on the larger absolute value of the two numbers. Enter 1 for 1%. For example, 100 and 101 match at 1% (difference 1, allowed difference 1.01)."
      : "A fixed difference in the column’s units. For example, 0.50 allows 100.00 and 100.40 to match. This is useful for rounding and values near zero."}
    {" Both rules apply only to numeric values. The larger allowed difference is used; the limits are not added. With both at zero, numeric values must be equal. These are not percentages of differing records."}
  </HelpTip>;
}
