import { useLanguage } from "../i18n/LanguageProvider";
/** Decorative motion illustrates comparison, never measured progress or results. */
export function ComparisonRunAnimation({ state }: { state: "queued" | "running" }) {
  const { t: tr } = useLanguage();
  return (
    <div className="comparison-wait" data-state={state}>
      <svg className="comparison-motion" viewBox="0 0 360 200" fill="none" aria-hidden="true" focusable="false">
        <ellipse cx="180" cy="172" rx="142" ry="12" className="comparison-motion-shadow" />
        <g className="comparison-motion-connections" strokeWidth="2" strokeDasharray="3 6">
          <path d="M124 100H158" className="comparison-motion-source" />
          <path d="M236 100H202" className="comparison-motion-target" />
        </g>
        {[{ x: 18, side: "source" }, { x: 236, side: "target" }].map(({ x, side }) => (
          <g key={side} transform={`translate(${x} 40)`}>
            <g className={`comparison-motion-table comparison-motion-${side}`}>
              <rect width="106" height="120" rx="12" className="comparison-motion-surface" />
              <path d="M0 33H106M36 33V120M70 33V120M0 62H106M0 91H106" className="comparison-motion-grid" />
              <circle cx="15" cy="17" r="3" fill="currentColor" />
              <path d="M26 17H62" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              {[47, 77, 106].map((y, i) => (
                <g key={y} className={`comparison-motion-row comparison-motion-row-${i}`} stroke="currentColor" strokeWidth="4" strokeLinecap="round">
                  <path d={`M12 ${y}H24M47 ${y}H58M81 ${y}H93`} />
                </g>
              ))}
              <rect x="5" y="37" width="96" height="20" rx="5" className="comparison-motion-scan" fill="currentColor" />
            </g>
          </g>
        ))}
        <g className="comparison-motion-source">
          <rect className="comparison-motion-packet comparison-motion-packet-left" x="128" y="96" width="8" height="8" rx="2" fill="currentColor" />
        </g>
        <g className="comparison-motion-target">
          <rect className="comparison-motion-packet comparison-motion-packet-right" x="224" y="96" width="8" height="8" rx="2" fill="currentColor" />
        </g>
        <g className="comparison-motion-core">
          <circle cx="180" cy="100" r="26" className="comparison-motion-halo" />
          <circle cx="180" cy="100" r="19" className="comparison-motion-surface" />
          <g strokeWidth="3" strokeLinecap="round">
            <path d="M171 96H187M184 92L188 96L184 100" className="comparison-motion-source" />
            <path d="M189 104H173M176 100L172 104L176 108" className="comparison-motion-target" />
          </g>
        </g>
      </svg>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h2>{state === "queued" ? tr("Comparison queued") : tr("Analyzing comparison data")}</h2>
      </div>
      <p className="muted">{state === "queued" ? tr("Waiting for a worker to start the comparison.") : tr("Comparing your datasets and preparing the results.")}</p>
      <p className="muted small">{tr("This page updates automatically every two seconds. You can navigate away and return to this run.")}</p>
    </div>
  );
}
