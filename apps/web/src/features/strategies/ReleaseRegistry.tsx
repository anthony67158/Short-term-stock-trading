import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";
import type { components } from "../../../../../packages/api-client/schema";
import { Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";
import { ReleaseHistoryRow } from "./ReleaseHistoryRow";

type Release = components["schemas"]["ReleaseView"];
type ReleasePage = components["schemas"]["ReleasePage"];

export function ReleaseRegistry({ page }: { page: ReleasePage }) {
  const cache = useQueryClient();
  const command = useRef("");
  const active = page.releases.find(
    (row) => row.status === "ACTIVE" && row.bundleId === page.activeReleaseId,
  );
  const activeCandidate = active?.sourceCandidateBundleId;
  const activate = useMutation({
    mutationFn: async (candidate: Release) => {
      command.current = crypto.randomUUID();
      const result = await api.POST("/api/v1/releases", {
        params: { header: { "Idempotency-Key": command.current } },
        body: {
          candidateId: candidate.bundleId,
          expectedActiveReleaseId: page.activeReleaseId,
          reason: "用户在发布界面确认激活联合影子版本。",
        },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["releases"] }),
        cache.invalidateQueries({ queryKey: ["decision-capability"] }),
      ]);
    },
  });
  const rollback = useMutation({
    mutationFn: async (target: Release) => {
      command.current = crypto.randomUUID();
      const result = await api.POST(
        "/api/v1/releases/{release_id}/rollbacks",
        {
          params: {
            path: { release_id: target.bundleId },
            header: { "Idempotency-Key": command.current },
          },
          body: {
            expectedActiveReleaseId: page.activeReleaseId!,
            reason: "用户在发布界面确认回滚至已验证历史联合包。",
          },
        },
      );
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["releases"] }),
        cache.invalidateQueries({ queryKey: ["decision-capability"] }),
      ]);
    },
  });
  if (page.releases.length === 0) {
    return (
      <Empty title="尚无发布记录">
        <PackageOpen size={20} />
        通过完整性校验的联合包会保留在发布历史。
      </Empty>
    );
  }
  const error = activate.error ?? rollback.error;
  return (
    <>
      <section className="release-current">
        <div>
          <span className="secondary">活动联合包</span>
          <strong>{page.activeReleaseId ?? "无"}</strong>
        </div>
        <div>
          <span className="secondary">运行模式</span>
          <strong>{active ? "SHADOW · 不允许真实账户新增风险" : "未登记"}</strong>
        </div>
        <div>
          <span className="secondary">门禁</span>
          <strong>{active?.blockerCodes.length ?? 0} 项未通过</strong>
        </div>
      </section>
      {active && active.blockerCodes.length > 0 && (
        <details className="release-blockers">
          <summary>查看发布门禁</summary>
          <ul>
            {active.blockerCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <section className="ledger-section">
        <h2>发布历史</h2>
        <div
          className="table-scroll"
          role="region"
          aria-label="联合包发布历史，可横向滚动"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>联合包</th>
                <th>操作</th>
                <th>状态</th>
                <th>门禁</th>
                <th>Manifest</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
            {page.releases.map((row) => (
              <ReleaseHistoryRow
                key={row.id}
                row={row}
                activeReleaseId={page.activeReleaseId}
                activeCandidateId={activeCandidate}
                canManage={page.canManage}
                pending={activate.isPending || rollback.isPending}
                onActivate={(candidate) => activate.mutate(candidate)}
                onRollback={(target) => rollback.mutate(target)}
              />
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
    </>
  );
}
