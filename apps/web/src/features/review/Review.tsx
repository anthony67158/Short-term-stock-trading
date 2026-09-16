import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarSearch, FlaskConical, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type ReviewReport = components["schemas"]["ReviewReportView"];
type ReviewMetric = components["schemas"]["ReviewMetric"];
type DriftReport = components["schemas"]["CycleDriftReportView"];

const categoryLabels = {
  STRATEGY: "策略",
  EXECUTION: "执行",
  DATA: "数据",
} as const;

const conclusionLabels = {
  OBSERVED: "结构化观察",
  HYPOTHESIS: "归因假设",
} as const;

const proposalStatusLabels = {
  DRAFT: "待实验",
  COMPILED: "已编译",
  REJECTED: "已拒绝",
} as const;

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function metricValue(metric: ReviewMetric) {
  if (metric.unit === "COUNT") return Number(metric.value).toLocaleString();
  return `${(Number(metric.value) * 100).toFixed(2)}%`;
}

function DriftPanel({ drift }: { drift?: DriftReport }) {
  if (!drift) {
    return (
      <section className="ledger-section">
        <h2>周期与漂移</h2>
        <p className="secondary">尚无可比较的周期报告。</p>
      </section>
    );
  }
  return (
    <section className="ledger-section" aria-labelledby="drift-title">
      <div className="section-toolbar">
        <h2 id="drift-title">周期与漂移</h2>
        <span className={`status-label ${drift.status.toLowerCase()}`}>
          {drift.status === "STABLE"
            ? "稳定"
            : drift.status === "WARNING"
              ? "检测到漂移"
              : "暂不可比较"}
        </span>
      </div>
      <div className="cycle-support">
        {drift.cycleSupport.map((cycle) => (
          <div key={cycle.horizon}>
            <span className="secondary">
              {cycle.horizon === "5_TRADING_DAYS"
                ? "短周期"
                : "中周期"}
            </span>
            <strong>
              {cycle.status === "ACTIVE"
                ? "已支持"
                : `不支持 · ${cycle.reasonCode}`}
            </strong>
          </div>
        ))}
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="跨周期漂移指标，可横向滚动"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>指标</th>
              <th className="numeric">基线</th>
              <th className="numeric">当前</th>
              <th className="numeric">变化</th>
              <th>判断</th>
            </tr>
          </thead>
          <tbody>
            {drift.metrics.map((metric) => (
              <tr key={metric.metricId}>
                <td>{metric.metricId}</td>
                <td className="numeric">{metric.baselineValue ?? "—"}</td>
                <td className="numeric">{metric.currentValue ?? "—"}</td>
                <td className="numeric">{metric.delta ?? "—"}</td>
                <td>
                  {metric.drifted == null
                    ? "不可比较"
                    : metric.drifted
                      ? "超出阈值"
                      : "阈值内"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {drift.blockerCodes.length > 0 && (
        <p className="source-note">
          {drift.blockerCodes.join(" · ")}
        </p>
      )}
    </section>
  );
}

function Report({
  report,
  drift,
  canCompile,
  compilingId,
  onCompile,
}: {
  report: ReviewReport;
  drift?: DriftReport;
  canCompile: boolean;
  compilingId?: string;
  onCompile: (proposalId: string) => void;
}) {
  const metrics = new Map(
    report.metricSnapshot.metrics.map((metric) => [
      metric.metricId,
      metric,
    ]),
  );
  return (
    <>
      <section className="review-summary" aria-labelledby="review-summary-title">
        <div className="section-toolbar">
          <div>
            <h2 id="review-summary-title">
              {report.reviewDate} 复盘
            </h2>
            <p className="source-note">
              {report.modelId} · {report.protocolVersion}
            </p>
          </div>
          <span className="status-label succeeded">已完成</span>
        </div>
        <div className="experiment-summary">
          {report.metricSnapshot.metrics.map((metric) => (
            <div key={metric.metricId}>
              <span className="secondary">{metric.label}</span>
              <strong>{metricValue(metric)}</strong>
            </div>
          ))}
        </div>
      </section>
      <DriftPanel drift={drift} />
      <section className="ledger-section" aria-labelledby="failure-clusters-title">
        <h2 id="failure-clusters-title">失败簇与偏差</h2>
        {report.metricSnapshot.failureClusters.length === 0 ? (
          <p className="secondary">本期没有形成失败簇。</p>
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="失败簇与来源样本，可横向滚动"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>类别</th>
                  <th>失败簇</th>
                  <th className="numeric">样本</th>
                  <th>策略失败口径</th>
                  <th>来源 episode</th>
                </tr>
              </thead>
              <tbody>
                {report.metricSnapshot.failureClusters.map((cluster) => (
                  <tr key={cluster.clusterId}>
                    <td>
                      <span
                        className={`status-label ${cluster.category.toLowerCase()}`}
                      >
                        {categoryLabels[cluster.category]}
                      </span>
                    </td>
                    <td>
                      <strong>{cluster.label}</strong>
                      <div className="secondary">{cluster.clusterId}</div>
                    </td>
                    <td className="numeric">
                      {cluster.sampleCount.toLocaleString()}
                    </td>
                    <td>
                      {cluster.strategyFailureEligible
                        ? "计入策略归因"
                        : "不计入策略失败"}
                    </td>
                    <td>
                      <code>
                        {cluster.sourceSampleIds
                          .map((id) => id.slice(0, 8))
                          .join(" · ")}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="review-columns">
        <section className="review-section" aria-labelledby="review-conclusions-title">
          <h2 id="review-conclusions-title">复盘结论</h2>
          <p className="review-lead">{report.output.summary}</p>
          {report.output.conclusions.map((conclusion, index) => (
            <article className="review-finding" key={`${conclusion.kind}-${index}`}>
              <span className={`status-label ${conclusion.kind.toLowerCase()}`}>
                {conclusionLabels[conclusion.kind]}
              </span>
              <p>{conclusion.statement}</p>
              <p className="source-note">
                {conclusion.metricRefs
                  .map((reference) => {
                    const metric = metrics.get(reference);
                    return metric
                      ? `${metric.label} ${metricValue(metric)}`
                      : reference;
                  })
                  .join(" · ")}
              </p>
            </article>
          ))}
        </section>
        <section className="review-section" aria-labelledby="review-proposals-title">
          <h2 id="review-proposals-title">改进提案</h2>
          {report.proposals.length === 0 ? (
            <p className="secondary">本期没有形成可实验提案。</p>
          ) : (
            report.proposals.map((proposal) => (
              <article className="review-proposal" key={proposal.id}>
                <div className="section-toolbar">
                  <h3>{proposal.title}</h3>
                  <span className={`status-label ${proposal.status.toLowerCase()}`}>
                    {proposalStatusLabels[proposal.status]}
                  </span>
                </div>
                <p>{proposal.hypothesis}</p>
                <p className="source-note">
                  {proposal.changeType} · {proposal.direction} · episode{" "}
                  {proposal.sourceSampleIds
                    .map((id) => id.slice(0, 8))
                    .join("、")}
                </p>
                {proposal.status === "DRAFT" && (
                  <Button
                    disabled={!canCompile || compilingId === proposal.id}
                    onClick={() => onCompile(proposal.id)}
                  >
                    <FlaskConical size={16} />
                    {compilingId === proposal.id
                      ? "编译中"
                      : "编译实验草案"}
                  </Button>
                )}
              </article>
            ))
          )}
        </section>
      </div>
    </>
  );
}

export function Review() {
  const cache = useQueryClient();
  const command = useRef({ date: "", key: "" });
  const compilationCommands = useRef(new Map<string, string>());
  const [reviewDate, setReviewDate] = useState(shanghaiDate);
  const [selectedId, setSelectedId] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("reviewJob");
  const capability = useQuery({
    queryKey: ["review-capability"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/review-capability", { signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const reports = useQuery({
    queryKey: ["reviews"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/reviews", {
        params: { query: { limit: 30 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.reports;
    },
  });
  const drift = useQuery({
    queryKey: ["drift-reports"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/drift-reports", {
        params: { query: { limit: 30 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.reports;
    },
  });
  const job = useQuery({
    queryKey: ["job", jobId],
    enabled: !!jobId,
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: jobId! } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    refetchInterval: (query) =>
      ["QUEUED", "RUNNING"].includes(query.state.data?.status ?? "")
        ? 1000
        : false,
  });
  useEffect(() => {
    if (job.data?.status === "SUCCEEDED") {
      void cache.invalidateQueries({ queryKey: ["reviews"] });
      void cache.invalidateQueries({ queryKey: ["strategy-versions"] });
    }
  }, [cache, job.data?.status]);
  const run = useMutation({
    mutationFn: async () => {
      if (command.current.date !== reviewDate) {
        command.current = {
          date: reviewDate,
          key: crypto.randomUUID(),
        };
      }
      const result = await api.POST("/api/v1/review-runs", {
        params: {
          header: {
            "Idempotency-Key": command.current.key,
          },
        },
        body: { reviewDate },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      setSearchParams(
        { reviewJob: result.data.data.id },
        { replace: true },
      );
    },
  });
  const compile = useMutation({
    mutationFn: async (proposalId: string) => {
      let key = compilationCommands.current.get(proposalId);
      if (!key) {
        key = crypto.randomUUID();
        compilationCommands.current.set(proposalId, key);
      }
      const result = await api.POST(
        "/api/v1/improvement-proposals/{proposal_id}/compilations",
        {
          params: {
            path: { proposal_id: proposalId },
            header: { "Idempotency-Key": key },
          },
          body: {},
        },
      );
      if (!result.data) throw new Error(errorMessage(result.error));
      setSearchParams(
        { reviewJob: result.data.data.id },
        { replace: true },
      );
      return proposalId;
    },
  });
  const selected =
    reports.data?.find((report) => report.id === selectedId)
    ?? reports.data?.[0];
  const running = ["QUEUED", "RUNNING"].includes(job.data?.status ?? "");
  const error =
    reports.error
    ?? drift.error
    ?? run.error
    ?? compile.error
    ?? job.error;
  return (
    <>
      <header className="workspace-header">
        <h1>复盘与洞察</h1>
        <Button
          className="icon-button"
          aria-label="刷新复盘记录"
          title="刷新"
          disabled={reports.isFetching}
          onClick={() => {
            void reports.refetch();
            void drift.refetch();
          }}
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      <div className="workspace-content">
        <section className="review-toolbar" aria-label="复盘任务">
          <label className="field">
            <span>交易日</span>
            <input
              type="date"
              value={reviewDate}
              max={shanghaiDate()}
              onChange={(event) => setReviewDate(event.target.value)}
            />
          </label>
          <Button
            variant="primary"
            disabled={
              !capability.data?.available
              || !reviewDate
              || running
              || run.isPending
            }
            onClick={() => run.mutate()}
          >
            <CalendarSearch size={16} />
            {run.isPending ? "提交中" : "生成复盘"}
          </Button>
          <span className="secondary">
            {capability.data?.reason ?? capability.data?.model}
          </span>
        </section>
        {job.data && (
          <div className="task-status" role="status">
            <span>
              {job.data.stage}
              {job.data.message ? `：${job.data.message}` : ""}
            </span>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {errorMessage(error)}
          </p>
        )}
        {reports.isPending ? (
          <p role="status">正在读取复盘记录…</p>
        ) : selected ? (
          <>
            {(reports.data?.length ?? 0) > 1 && (
              <label className="field compact-select review-picker">
                <span>历史复盘</span>
                <select
                  value={selected.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {reports.data?.map((report) => (
                    <option key={report.id} value={report.id}>
                      {report.reviewDate}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Report
              report={selected}
              drift={drift.data?.find(
                (item) => item.currentDate === selected.reviewDate,
              )}
              canCompile={
                (capability.data?.available ?? false) && !running
              }
              compilingId={
                compile.isPending ? compile.variables : undefined
              }
              onCompile={(proposalId) => compile.mutate(proposalId)}
            />
          </>
        ) : (
          <Empty title="尚无复盘记录">
            <CalendarSearch size={20} />
            当日样本成熟后可生成复盘。
          </Empty>
        )}
      </div>
    </>
  );
}
