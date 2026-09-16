import { useState } from "react";
import { FlaskConical } from "lucide-react";
import type { components } from "../../../../../packages/api-client/schema";
import { Empty } from "../../components/Controls";

type Experiment = components["schemas"]["ExperimentView"];

const variantLabels = {
  JOINT: "完整联合",
  NO_AGENT: "去 Agent",
  NO_QUANT: "去量化",
  FORMULA: "持有基线",
} as const;

function percent(value: string | null) {
  return value == null ? "—" : `${(Number(value) * 100).toFixed(2)}%`;
}

export function ExperimentComparison({
  experiments,
}: {
  experiments: Experiment[];
}) {
  const [selectedId, setSelectedId] = useState("");
  const selected =
    experiments.find((row) => row.id === selectedId) ?? experiments[0];
  if (!selected) {
    return (
      <Empty title="尚无实验">
        <FlaskConical size={20} />
        冻结策略版本后运行四组消融。
      </Empty>
    );
  }
  const result = selected.result;
  return (
    <section className="ledger-section">
      <div className="section-toolbar">
        <h2>四组消融</h2>
        <label className="field compact-select">
          <span>实验记录</span>
          <select
            value={selected.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {experiments.map((row) => (
              <option key={row.id} value={row.id}>
                {new Date(row.finishedAt).toLocaleDateString("zh-CN")} ·{" "}
                {row.status === "SUCCEEDED" ? "有效" : "失败"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="experiment-summary">
        <div>
          <span className="secondary">评估状态</span>
          <strong>
            {result.evaluationStatus === "VALID" ? "有效" : "证据不足"}
          </strong>
        </div>
        <div>
          <span className="secondary">成熟样本</span>
          <strong>
            {result.effectiveSamples.toLocaleString()} /{" "}
            {result.minimumEffectiveSamples.toLocaleString()}
          </strong>
        </div>
        <div>
          <span className="secondary">确认集</span>
          <strong>{result.confirmationSetId}</strong>
        </div>
        <div>
          <span className="secondary">失败代码</span>
          <strong>{selected.failureCode ?? "—"}</strong>
        </div>
      </div>
      <div
        className="table-scroll"
        role="region"
        aria-label="四组消融指标，可横向滚动"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>对照组</th>
              <th className="numeric">样本</th>
              <th className="numeric">平均费后收益</th>
              <th className="numeric">相对基线</th>
              <th className="numeric">正收益率</th>
              <th>95% 区间</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(variantLabels).map(([key, label]) => {
              const metric = result.variants[key];
              return (
                <tr key={key}>
                  <td>{label}</td>
                  <td className="numeric">{metric?.sampleCount ?? 0}</td>
                  <td className="numeric">
                    {percent(metric?.meanNetReturn ?? null)}
                  </td>
                  <td className="numeric">
                    {percent(metric?.meanDeltaVsFormula ?? null)}
                  </td>
                  <td className="numeric">
                    {metric?.positiveRate == null
                      ? "—"
                      : `${(metric.positiveRate * 100).toFixed(1)}%`}
                  </td>
                  <td>
                    {metric?.confidence95Lower == null
                      ? "—"
                      : `${percent(metric.confidence95Lower)} 至 ${percent(
                          metric.confidence95Upper,
                        )}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="source-note">
        数据集 {result.dataset.datasetId} · 排除{" "}
        {result.excludedSamples.toLocaleString()} 个样本 ·
        四组使用同一确认集、费用、风险和模拟政策。
      </p>
    </section>
  );
}
