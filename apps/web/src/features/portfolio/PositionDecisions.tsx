import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Account = components["schemas"]["AccountView"];
type Position = components["schemas"]["PositionView"];
type Decision = components["schemas"]["PositionDecision"];

const actionLabels = {
  HOLD: "保持",
  ADD: "增加",
  REDUCE: "减少",
  EXIT: "退出",
  NONE: "不可用",
} as const;

const reasonLabels: Record<string, string> = {
  JOINT_INPUT_INCOMPLETE: "量化动作价值或持仓研判尚未齐备",
  JOINT_RELEASE_NOT_CONFIGURED: "尚未配置联合发布版本",
  JOINT_RELEASE_INVALID: "联合发布版本校验失败",
  SHADOW_RELEASE_SIMULATION_ONLY: "影子版本仅用于模拟账户",
  AGENT_QUANT_CONFLICT_REQUIRES_REVIEW: "量化与持仓论点存在冲突",
  INVALIDATED_THESIS_REQUIRES_REVIEW: "持仓论点失效，需要优先复核",
};

export function PositionDecisions({
  account,
  positions,
  accountVersion,
}: {
  account: Account;
  positions: Position[];
  accountVersion: number;
}) {
  const cache = useQueryClient();
  const commands = useRef(new Map<string, string>());
  const [activeJob, setActiveJob] = useState<{
    id: string;
    instrumentId: string;
  } | null>(null);
  const capability = useQuery({
    queryKey: ["decision-capability"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/decision-capability", { signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const decisions = useQuery({
    queryKey: ["decisions", account.id],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/decisions", {
        params: { path: { account_id: account.id }, query: { limit: 100 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.decisions;
    },
  });
  const job = useQuery({
    queryKey: ["job", activeJob?.id],
    enabled: !!activeJob,
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: activeJob!.id } },
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
      void cache.invalidateQueries({ queryKey: ["decisions", account.id] });
    }
  }, [account.id, cache, job.data?.status]);
  const evaluate = useMutation({
    mutationFn: async (position: Position) => {
      const body = {
        instrumentId: position.instrumentId,
        expectedVersion: accountVersion,
        reason: "用户发起持仓联合复核",
      };
      let key = commands.current.get(position.instrumentId);
      if (!key) {
        key = crypto.randomUUID();
        commands.current.set(position.instrumentId, key);
      }
      const result = await api.POST(
        "/api/v1/accounts/{account_id}/evaluations",
        {
          params: {
            path: { account_id: account.id },
            header: { "Idempotency-Key": key },
          },
          body,
        },
      );
      if (!result.data) throw new Error(errorMessage(result.error));
      setActiveJob({
        id: result.data.data.id,
        instrumentId: position.instrumentId,
      });
    },
  });
  const byInstrument = new Map(
    (decisions.data ?? []).map((decision) => [decision.instrumentId, decision]),
  );
  const release = capability.data;
  const running = ["QUEUED", "RUNNING"].includes(job.data?.status ?? "");
  return <section className="ledger-section">
    <div className="section-toolbar">
      <h2>联合持仓建议</h2>
      <span className={`status-label ${release?.status?.toLowerCase() ?? ""}`}>
        {release?.status === "SHADOW" ? "影子运行" : release?.status === "READY" ? "生产可用" : "评估不可用"}
      </span>
    </div>
    <p className="source-note">
      {capability.isPending ? "正在核验联合发布版本…" : capability.isError
        ? "无法读取联合发布状态"
        : release
          ? `${release.releaseId} · ${release.allowsNewRisk ? "允许账户约束内新增风险" : "不允许真实账户新增风险"} · ${(release.blockerCodes ?? []).length} 项门禁待消除`
          : "联合发布状态缺失"}
    </p>
    {positions.length === 0 ? <Empty title="暂无可评估持仓">持仓建立后，可在这里查看量化参考、Agent论点与唯一建议。</Empty>
      : <div className="table-scroll" role="region" aria-label="联合持仓建议，可横向滚动" tabIndex={0}>
        <table>
          <thead><tr><th>股票</th><th>当前动作</th><th>量化 / Agent</th><th>状态说明</th><th>操作</th></tr></thead>
          <tbody>{positions.map((position) => {
            const decision = byInstrument.get(position.instrumentId) as Decision | undefined;
            const isThisJob = activeJob?.instrumentId === position.instrumentId;
            const blockedReal = account.kind === "REAL" && release?.status === "SHADOW";
            return <tr key={position.instrumentId}>
              <td>{position.name}<div className="secondary">{position.instrumentId}</div></td>
              <td><strong>{decision ? actionLabels[decision.action] : "尚未评估"}</strong>
                {decision && <div className="secondary">目标 {decision.targetQuantityShares ?? "—"} 股</div>}
              </td>
              <td>{decision?.quantTrend ? `趋势 ${decision.quantTrend}` : "量化待完成"}
                <div className="secondary">{decision?.agentThesisStatus ? `论点 ${decision.agentThesisStatus}` : "Agent待完成"}</div>
              </td>
              <td>{decision
                ? reasonLabels[decision.reasonCodes[0]] ?? decision.decisionReason
                : blockedReal ? "影子版本不用于实盘账户" : "尚无当前决策"}
                {isThisJob && job.data?.message && <div className="secondary">{job.data.message}</div>}
              </td>
              <td><Button
                disabled={blockedReal || evaluate.isPending || (isThisJob && running)}
                onClick={() => evaluate.mutate(position)}
                aria-label={`评估${position.name}`}
              ><RefreshCw size={15} />{isThisJob && running ? "评估中" : "联合评估"}</Button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    {(evaluate.isError || job.isError) &&
      <p className="error" role="alert">{errorMessage(evaluate.error || job.error)}</p>}
  </section>;
}
