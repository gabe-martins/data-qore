import { useEffect, useState } from "react";
import { useLanguage } from "../../i18n/LanguageProvider";
import type { Model } from "../../api";
import { Card } from "../common";
import { ComparisonRunAnimation } from "../ComparisonRunAnimation";
import { Charts } from "./Charts";
import { ColumnAnalysis } from "./ColumnAnalysis";
import { Diagnosis } from "./Diagnosis";
import { Dimensions } from "./Dimensions";
import { RecordInspection } from "./RecordInspection";
import { Summary } from "./Summary";
import { motion } from "./shared";

export { ExecutionContext } from "./ExecutionContext";

const sections = [
  { id: "quality-summary", name: "Summary" },
  { id: "quality-charts", name: "Charts" },
  { id: "quality-dimensions", name: "Dimensions" },
  { id: "quality-columns", name: "Columns" },
  { id: "quality-diagnosis", name: "Diagnosis" },
  { id: "quality-records", name: "Records" },
];

/** Quality of one selected execution. Record filters live here because the
 *  summary, charts, column table and diagnosis all drive the record inspection. */
export function ComparisonQuality({ quality }: { quality: Model<"QualityOut"> }) {
  const { t: tr } = useLanguage();
  const [dimension, setDimension] = useState("consistency");
  const [state, setState] = useState("all"),
    [column, setColumn] = useState("");
  const result: any = quality.result,
    run = quality.run,
    evidence: any = quality.evidence;
  const available = !!result,
    captured = ["available", "partial"].includes(evidence.status);
  useEffect(() => {
    if (available && window.location.hash === "#quality-records")
      document.getElementById("quality-records")?.scrollIntoView({ behavior: "auto" });
  }, [run.id, available]);
  if (!result)
    return (
      <Card title={tr("Comparison Quality")}>
        {run.status === "queued" || run.status === "running" ? (
          <ComparisonRunAnimation state={run.status} />
        ) : (
          <p>{tr("Indicators unavailable. This execution did not publish a completed result.")}</p>
        )}
      </Card>
    );
  const jump = (id: string, block: ScrollLogicalPosition = "start") =>
    document.getElementById(id)?.scrollIntoView({ behavior: motion(), block });
  const setFilters = (nextState: string, nextColumn: string) => {
    setState(nextState);
    setColumn(nextColumn);
  };
  const inspect = (nextState = "all", nextColumn = "") => {
    setFilters(nextState, nextColumn);
    jump("quality-records");
  };
  const openDimension = (id: string) => {
    setDimension(id);
    jump(`dimension-${id}`, "nearest");
  };
  return (
    <section aria-label={tr("Comparison Quality")} className="comparison-quality">
      <nav className="overview-metric-tabs quality-nav" aria-label={tr("Sections of this execution")}>
        {sections.map((s) => (
          <button key={s.id} type="button" onClick={() => jump(s.id)}>
            {tr(s.name)}
          </button>
        ))}
      </nav>
      <div id="quality-summary">
        <Summary quality={quality} openDimension={openDimension} jump={jump} />
      </div>
      <div id="quality-charts">
        <Charts quality={quality} captured={captured} inspect={inspect} />
      </div>
      <div id="quality-dimensions">
        <Dimensions quality={quality} dimension={dimension} setDimension={setDimension} />
      </div>
      <ColumnAnalysis
        runId={run.id}
        result={result}
        captured={captured}
        hasPrevious={!!quality.previous}
        inspect={inspect}
      />
      <div id="quality-diagnosis">
        <Diagnosis quality={quality} captured={captured} state={state} inspect={inspect} />
      </div>
      <RecordInspection
        runId={run.id}
        result={result}
        evidence={evidence}
        state={state}
        column={column}
        setFilters={setFilters}
      />
    </section>
  );
}
