import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, ArrowUpRight } from "lucide-react";
import { QualityTrend } from "../components/QualityTrend";
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
    queryFn: () => api<Model<"OverviewOut">>("/overview", { cache: "no-store" }),
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  const settings = useQuery({ queryKey: ["environment-settings"], queryFn: () => api<Model<"EnvironmentSettingsOut">>("/environment-settings"), refetchOnMount: "always" });
  const d = q.data;
  return (
    <>
      <PageTitle
        title="Overview"
        subtitle="Monitor comparison agreement, sample quality, and the latest completed runs."
        action={
          <Button asChild>
            <Link to="/comparisons/new">
              <Plus size={18} />
              New comparison
            </Link>
          </Button>
        }
      />
      <ErrorBox error={q.error || settings.error} />
      {q.isPending ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="overview-stats">
              <div className="overview-indicators">
              <Stat
                label="COMPARISON AGREEMENT"
                value={percent(d.comparison_agreement.percentage)}
                detail={
                  <>
                    Coverage {percent(d.comparison_agreement.coverage_percentage)} ·{" "}
                    {d.comparison_agreement.evaluated.toLocaleString()} evaluated positions ·{" "}
                    {d.evaluated_comparisons}/{d.active_comparisons} comparisons evaluated
                  </>
                }
              />
              <Stat label="Sample quality" value={percent(d.sample_quality.percentage)} detail={`Source validity checks · coverage ${percent(d.sample_quality.coverage_percentage)} · ${d.sample_quality.evaluated.toLocaleString()} checks evaluated`} />
              </div>
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
              <QualityTrend target={settings.data?.comparison_target_percentage} />
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
                      <span>{a.name ?? `Comparison ${a.comparison_id.slice(0, 8)}`}</span>
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
