import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, ArrowUpRight } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { api, type Model } from "../api";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  PageTitle,
  percent,
  RunsTable,
  Stat,
} from "../components/common";
export function Overview() {
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Model<"OverviewOut">>("/overview"),
  });
  const d = q.data;
  return (
    <>
      <PageTitle
        title="Overview"
        subtitle="Monitor sample quality, recent runs, and observations that need attention."
        action={
          <Button asChild>
            <Link to="/comparisons/new">
              <Plus size={18} />
              New comparison
            </Link>
          </Button>
        }
      />
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="overview-stats">
              <Stat
                label="SAMPLE QUALITY"
                value={percent(d.sample_quality.percentage)}
                detail={
                  <>
                    Coverage {percent(d.sample_quality.coverage_percentage)} ·{" "}
                    {d.sample_quality.evaluated.toLocaleString()} checks
                    evaluated
                  </>
                }
              />
              <div className="stats-grid">
                <Stat label="Active comparisons" value={d.active_comparisons} />
                <Stat
                  label="Compatible in sample"
                  value={d.latest_conclusions.compatible_in_sample ?? 0}
                />
                <Stat
                  label="Differences observed"
                  value={d.latest_conclusions.difference_observed ?? 0}
                />
                <Stat
                  label="Failed latest runs"
                  value={d.latest_conclusions.failed ?? 0}
                />
              </div>
            </div>
            <div className="content-columns">
              <Card
                title="Quality over time"
                subtitle="Weighted sample checks · last 7 UTC days"
              >
                <div className="chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={d.trend.map((t) => ({
                        ...t,
                        quality:
                          t.percentage === null ? null : Number(t.percentage),
                      }))}
                    >
                      <CartesianGrid
                        stroke="var(--semantic-border-default)"
                        vertical={false}
                      />
                      <XAxis dataKey="day" tickFormatter={(v) => v.slice(5)} />
                      <YAxis domain={[0, 100]} unit="%" />
                      <Tooltip />
                      <Area
                        type="monotone"
                        dataKey="quality"
                        name="Sample quality %"
                        stroke="var(--primitive-green-700)"
                        fill="var(--primitive-green-100)"
                        connectNulls={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <p className="small muted">
                  Latest successful sample per active comparison above. Daily
                  trend includes all comparisons completed that day. No value
                  means no evaluation.
                </p>
              </Card>
              <Card
                title="Requires attention"
                subtitle="Latest outcomes from active comparisons"
              >
                {d.attention.length ? (
                  d.attention.map((a) => (
                    <Link
                      key={a.comparison_id}
                      className="attention-row"
                      to={"/comparisons/" + a.comparison_id}
                    >
                      <Badge value={a.state} />
                      <span>Comparison {a.comparison_id.slice(0, 8)}</span>
                      <ArrowUpRight size={17} />
                    </Link>
                  ))
                ) : (
                  <Empty title="No observations to review">
                    Run a comparison to collect evidence.
                  </Empty>
                )}
              </Card>
            </div>
            <Card
              title="Recent runs"
              subtitle="Latest profiles and comparisons"
            >
              {d.recent_runs.length ? (
                <>
                  <RunsTable runs={d.recent_runs} />
                  <Link className="view-all" to="/runs">
                    View all runs →
                  </Link>
                </>
              ) : (
                <Empty title="No runs yet">
                  Connect a source and select a table to get started.
                </Empty>
              )}
            </Card>
          </>
        )
      )}
    </>
  );
}
