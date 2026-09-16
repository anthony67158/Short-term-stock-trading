import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Input } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Strategy = components["schemas"]["StrategyVersionView"];
type Experiment = components["schemas"]["ExperimentView"];

function candidateId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `joint-candidate-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

export function ReleaseCandidateForm({
  strategies,
  experiments,
}: {
  strategies: Strategy[];
  experiments: Experiment[];
}) {
  const cache = useQueryClient();
  const command = useRef("");
  const [id, setId] = useState(candidateId);
  const [experimentId, setExperimentId] = useState("");
  const eligible = experiments.filter((experiment) =>
    strategies.some(
      (strategy) =>
        strategy.id === experiment.strategyVersionId &&
        strategy.status === "EVALUATED",
    ),
  );
  const selected =
    eligible.find((experiment) => experiment.id === experimentId) ??
    eligible[0];
  const mutation = useMutation({
    mutationFn: async (body: components["schemas"]["ReleaseCandidateInput"]) => {
      command.current = crypto.randomUUID();
      const result = await api.POST("/api/v1/release-candidates", {
        params: { header: { "Idempotency-Key": command.current } },
        body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      setId(candidateId());
      await cache.invalidateQueries({ queryKey: ["releases"] });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    mutation.mutate({
      candidateId: id,
      strategyVersionId: selected.strategyVersionId,
      experimentId: selected.id,
      deploymentMode: "SHADOW",
      reason: String(data.get("reason")).trim(),
    });
  }
  if (!selected) return null;
  return (
    <section className="editor-section">
      <h2>登记发布候选</h2>
      <form className="release-form" onSubmit={submit}>
        <Input
          id="candidate-id"
          label="候选包编号"
          value={id}
          onChange={(event) => setId(event.target.value)}
          pattern="[A-Za-z0-9._:-]+"
          maxLength={160}
          required
        />
        <label className="field">
          <span>实验记录</span>
          <select
            value={selected.id}
            onChange={(event) => setExperimentId(event.target.value)}
          >
            {eligible.map((experiment) => (
              <option key={experiment.id} value={experiment.id}>
                {experiment.id.slice(0, 12)} ·{" "}
                {experiment.status === "SUCCEEDED" ? "有效" : "证据不足"}
              </option>
            ))}
          </select>
        </label>
        <Input
          id="candidate-reason"
          label="登记原因"
          name="reason"
          defaultValue="绑定冻结策略、消融证据和联合组件。"
          maxLength={500}
          required
        />
        <div className="form-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={mutation.isPending}
          >
            <PackageCheck size={16} />
            {mutation.isPending ? "正在校验" : "登记候选"}
          </Button>
        </div>
        {mutation.isError && (
          <p className="error" role="alert">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </section>
  );
}
