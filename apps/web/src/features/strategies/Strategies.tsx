import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";
import { ExperimentComparison } from "./ExperimentComparison";
import { ReleaseCandidateForm } from "./ReleaseCandidateForm";
import { ReleaseRegistry } from "./ReleaseRegistry";
import { StrategyRegistry } from "./StrategyRegistry";

type Tab = "versions" | "experiments" | "releases";

export function Strategies() {
  const [tab, setTab] = useState<Tab>("versions");
  const strategies = useQuery({
    queryKey: ["strategy-versions"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/strategy-versions", {
        params: { query: { limit: 100 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.strategyVersions;
    },
  });
  const experiments = useQuery({
    queryKey: ["experiments"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/experiments", {
        params: { query: { limit: 100 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.experiments;
    },
  });
  const releases = useQuery({
    queryKey: ["releases"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/releases", {
        params: { query: { limit: 100 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const pending =
    strategies.isPending || experiments.isPending || releases.isPending;
  const error = strategies.error ?? experiments.error ?? releases.error;
  const refresh = () =>
    Promise.all([
      strategies.refetch(),
      experiments.refetch(),
      releases.refetch(),
    ]);
  return (
    <>
      <header className="workspace-header">
        <h1>策略实验室</h1>
        <Button
          className="icon-button"
          aria-label="刷新策略实验室"
          title="刷新"
          disabled={pending}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="策略实验室视图">
        {(
          [
            ["versions", "策略版本"],
            ["experiments", "实验对比"],
            ["releases", "发布历史"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="workspace-content">
        {pending ? (
          <p role="status">正在读取策略、实验与发布记录…</p>
        ) : error ? (
          <div role="alert">
            <p className="error">{errorMessage(error)}</p>
            <Button onClick={() => void refresh()}>重新读取</Button>
          </div>
        ) : tab === "versions" ? (
          <StrategyRegistry strategies={strategies.data ?? []} />
        ) : tab === "experiments" ? (
          <ExperimentComparison experiments={experiments.data ?? []} />
        ) : (
          <>
            {releases.data?.canManage && (
              <ReleaseCandidateForm
                strategies={strategies.data ?? []}
                experiments={experiments.data ?? []}
              />
            )}
            <ReleaseRegistry
              page={
                releases.data ?? {
                  activeReleaseId: null,
                  canManage: false,
                  releases: [],
                }
              }
            />
          </>
        )}
      </div>
    </>
  );
}
