import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import { Link } from "react-router";
import { Button, Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

export function CandidateScan() {
  const cache = useQueryClient();
  const command = useRef("");
  const [jobId, setJobId] = useState<string | null>(null);
  const latest = useQuery({
    queryKey: ["candidate-scan"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/candidate-scans/latest", { signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
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
      void cache.invalidateQueries({ queryKey: ["candidate-scan"] });
    }
  }, [cache, job.data?.status]);
  const start = useMutation({
    mutationFn: async () => {
      command.current = crypto.randomUUID();
      const result = await api.POST("/api/v1/candidate-scans", {
        params: { header: { "Idempotency-Key": command.current } },
        body: { limit: 20 },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      setJobId(result.data.data.id);
    },
  });
  const scan = latest.data;
  const running = ["QUEUED", "RUNNING"].includes(job.data?.status ?? "");
  return <section className="ledger-section">
    <div className="section-toolbar">
      <h2>联合候选</h2>
      <Button
        variant="primary"
        disabled={running || start.isPending}
        onClick={() => start.mutate()}
      ><Radar size={16} />{running ? "扫描中" : "运行联合扫描"}</Button>
    </div>
    <p className="source-note">
      全市场模型排序与截至扫描时点有效的Agent事件研判分别召回；Agent事件不改写模型分数。
    </p>
    {[latest.error, job.error, start.error].filter(Boolean).map((error, index) =>
      <p key={index} role="alert" className="error">{errorMessage(error)}</p>)}
    {job.data && <p role="status" className="task-status">
      {job.data.stage}{job.data.message ? `：${job.data.message}` : ""}
    </p>}
    {latest.isPending ? <p role="status">正在读取最近扫描…</p>
      : !scan ? <Empty title="尚无联合候选">运行扫描后显示模型与Agent各自的召回来源。</Empty>
        : <>
          <p className="capability-note">
            {scan.releaseId} · {scan.releaseStatus === "SHADOW" ? "影子研究" : "生产可用"}
            {" · "}{scan.decisionDate} · 覆盖 {scan.eligibleInstruments.toLocaleString()} 只
          </p>
          <div className="table-scroll" role="region" aria-label="联合候选列表，可横向滚动" tabIndex={0}>
            <table>
              <thead><tr><th>股票</th><th>召回来源</th><th>模型排序</th><th>模型预期毛收益</th><th>Agent论点</th></tr></thead>
              <tbody>{scan.candidates.map((candidate) => <tr key={candidate.instrumentId}>
                <td><Link to={`/research/${candidate.instrumentId}`}>{candidate.name ?? candidate.instrumentId}</Link><div className="secondary">{candidate.instrumentId}</div></td>
                <td>{candidate.recallSources.map((source) => source === "MODEL" ? "量化模型" : "Agent事件").join(" + ")}</td>
                <td>{candidate.rankScore?.toFixed(4) ?? "—"}</td>
                <td>{candidate.expectedGrossReturn == null ? "—" : `${(candidate.expectedGrossReturn * 100).toFixed(2)}%`}</td>
                <td>{candidate.thesisStatus ?? "—"}{candidate.assessmentId && <div className="secondary">{candidate.assessmentId}</div>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
  </section>;
}
