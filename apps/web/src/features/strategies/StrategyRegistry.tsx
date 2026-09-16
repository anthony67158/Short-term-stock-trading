import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Snowflake } from "lucide-react";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Strategy = components["schemas"]["StrategyVersionView"];

const statusLabels = {
  DRAFT: "草稿",
  FROZEN: "已冻结",
  EVALUATED: "已评估",
} as const;

export function StrategyRegistry({
  strategies,
}: {
  strategies: Strategy[];
}) {
  const cache = useQueryClient();
  const command = useRef("");
  const [selectedId, setSelectedId] = useState("");
  const selected =
    strategies.find((row) => row.id === selectedId) ?? strategies[0];
  const freeze = useMutation({
    mutationFn: async (strategy: Strategy) => {
      const result = await api.POST(
        "/api/v1/strategy-versions/{strategy_version_id}/freeze",
        {
          params: { path: { strategy_version_id: strategy.id } },
          body: { expectedRevision: strategy.revision },
        },
      );
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["strategy-versions"] });
    },
  });
  const run = useMutation({
    mutationFn: async (strategy: Strategy) => {
      command.current = crypto.randomUUID();
      const result = await api.POST("/api/v1/experiments", {
        params: { header: { "Idempotency-Key": command.current } },
        body: {
          strategyVersionId: strategy.id,
          kind: "FOUR_WAY_ABLATION",
        },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["strategy-versions"] }),
        cache.invalidateQueries({ queryKey: ["experiments"] }),
      ]);
    },
  });
  if (!selected) {
    return (
      <Empty title="尚无策略版本">
        注册并冻结策略配置后，版本会出现在这里。
      </Empty>
    );
  }
  const error = freeze.error ?? run.error;
  return (
    <>
      <section className="ledger-section">
        <h2>策略版本</h2>
        <div
          className="table-scroll"
          role="region"
          aria-label="策略版本列表，可横向滚动"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>版本</th>
                <th>状态</th>
                <th>确认集</th>
                <th className="numeric">最低样本</th>
                <th>配置哈希</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((strategy) => (
                <tr key={strategy.id}>
                  <td>
                    <strong>{strategy.name}</strong>
                    <div className="secondary">
                      {strategy.strategyKey} · v{strategy.version}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`status-label ${strategy.status.toLowerCase()}`}
                    >
                      {statusLabels[strategy.status]}
                    </span>
                  </td>
                  <td>{strategy.confirmationSetId}</td>
                  <td className="numeric">
                    {strategy.minimumEffectiveSamples.toLocaleString()}
                  </td>
                  <td title={strategy.configHash}>
                    <code>{strategy.configHash.slice(0, 12)}</code>
                  </td>
                  <td>
                    <div className="control-group">
                      <Button onClick={() => setSelectedId(strategy.id)}>
                        查看
                      </Button>
                      {strategy.status === "DRAFT" && (
                        <Button
                          disabled={freeze.isPending}
                          onClick={() => freeze.mutate(strategy)}
                        >
                          <Snowflake size={16} />
                          冻结
                        </Button>
                      )}
                      {strategy.status === "FROZEN" && (
                        <Button
                          variant="primary"
                          disabled={run.isPending}
                          onClick={() => run.mutate(strategy)}
                        >
                          <Play size={16} />
                          运行
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && (
          <p className="error" role="alert">
            {errorMessage(error)}
          </p>
        )}
      </section>
      <section className="strategy-detail" aria-labelledby="strategy-detail-title">
        <div className="section-toolbar">
          <h2 id="strategy-detail-title">{selected.name}</h2>
          <span className={`status-label ${selected.status.toLowerCase()}`}>
            {statusLabels[selected.status]}
          </span>
        </div>
        <p>{selected.hypothesis}</p>
        <dl className="detail-grid">
          <div>
            <dt>数据快照</dt>
            <dd>{selected.dataset.datasetId}</dd>
          </div>
          <div>
            <dt>确认区间</dt>
            <dd>
              {selected.split.confirmationStart} -{" "}
              {selected.split.confirmationEnd}
            </dd>
          </div>
          <div>
            <dt>费用政策</dt>
            <dd>{selected.feePolicyVersion}</dd>
          </div>
          <div>
            <dt>风险政策</dt>
            <dd>{selected.riskPolicyVersion}</dd>
          </div>
        </dl>
        <details>
          <summary>冻结配置</summary>
          <pre className="policy-code">
            {JSON.stringify(
              {
                scope: selected.scope,
                config: selected.config,
                releasePolicy: selected.releasePolicy,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </section>
    </>
  );
}
