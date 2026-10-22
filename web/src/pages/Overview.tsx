import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  LineChart,
  Line,
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
  const [days, setDays] = useState(7);
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Model<"OverviewOut">>("/overview"),
    refetchInterval: 30000,
  });
  const trend = useQuery({
    queryKey: ["row-match-trend", days],
    queryFn: () =>
      api<Model<"RowMatchTrendOut">>(
        `/overview/row-match-trend?days=${days}&timezone=America%2FSao_Paulo`,
      ),
    refetchInterval: 30000,
  });
  const d = q.data;
  return (
    <>
      <PageTitle
        title="Overview"
        subtitle="Critical comparison metrics and latest execution outcomes."
        action={
          <Button asChild>
            <Link to="/comparisons/new">New comparison</Link>
          </Button>
        }
      />
      <ErrorBox error={q.error || trend.error} />
      {q.isPending ? (
        <Loading />
      ) : (
        d && (
          <>
            <div className="stats-grid">
              <Stat
                label="Row Match Rate"
                value={percent(d.row_match_rate.percentage)}
                detail={`${d.row_match_rate.passed} / ${d.row_match_rate.evaluated} evaluated records · coverage ${percent(d.row_match_rate.coverage_percentage)}`}
              />
              <Stat label="Active comparisons" value={d.active_comparisons} />
              <Stat
                label="Differences observed"
                value={d.latest_conclusions.difference_observed ?? 0}
              />
              <Stat
                label="Inconclusive"
                value={d.latest_conclusions.inconclusive ?? 0}
              />
            </div>
            <Card
              title="Row Match Rate over time"
              subtitle="Last terminal run per comparison per day · America/Sao_Paulo · today is partial"
            >
              <label>
                Period
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  {[7, 15, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
              </label>
              {trend.data?.overall.some((p) => p.percentage != null) ? (
                <>
                  <div style={{ height: 260, width: "100%" }}>
                    <ResponsiveContainer>
                      <LineChart
                        data={trend.data.overall.map((p) => ({
                          ...p,
                          value:
                            p.percentage == null ? null : Number(p.percentage),
                        }))}
                      >
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="day" />
                        <YAxis domain={[0, 100]} />
                        <Tooltip />
                        <Line
                          dataKey="value"
                          name="Row Match Rate (%)"
                          stroke="var(--semantic-chart-series-1)"
                          connectNulls={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <details>
                    <summary>Daily evaluations</summary>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Day</th>
                            <th>Row Match Rate</th>
                            <th>Equal / evaluated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trend.data.overall.map((p) => (
                            <tr key={p.day}>
                              <td>{p.day}</td>
                              <td>{percent(p.percentage)}</td>
                              <td>
                                {p.passed} / {p.evaluated}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </>
              ) : (
                <Empty title="No evaluated comparisons" />
              )}
              <p className="muted">
                Rates are weighted by evaluated records. Failed or unavailable
                evaluations remain gaps. A sample does not prove equality of
                entire tables.
              </p>
            </Card>
            <Card title="Requires attention">
              {d.attention.length ? (
                d.attention.map((a) => (
                  <p key={a.comparison_id}>
                    <Link to={`/comparisons/${a.comparison_id}`}>{a.name}</Link>{" "}
                    <Badge value={a.state} />
                  </p>
                ))
              ) : (
                <Empty title="No observations to review" />
              )}
            </Card>
            <Card title="Recent comparisons">
              {d.recent_runs.length ? (
                <RunsTable runs={d.recent_runs} />
              ) : (
                <Empty title="No runs yet" />
              )}
            </Card>
          </>
        )
      )}
    </>
  );
}
