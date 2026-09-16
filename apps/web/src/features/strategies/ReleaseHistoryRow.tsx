import { Rocket, RotateCcw } from "lucide-react";
import type { components } from "../../../../../packages/api-client/schema";
import { Button } from "../../components/Controls";

type Release = components["schemas"]["ReleaseView"];

const statusLabels = {
  APPROVED: "候选已校验",
  REJECTED: "候选拒绝",
  ACTIVE: "当前活动",
  RETIRED: "已退役",
} as const;

export function ReleaseHistoryRow({
  row,
  activeReleaseId,
  activeCandidateId,
  canManage,
  pending,
  onActivate,
  onRollback,
}: {
  row: Release;
  activeReleaseId: string | null;
  activeCandidateId: string | null | undefined;
  canManage: boolean;
  pending: boolean;
  onActivate: (row: Release) => void;
  onRollback: (row: Release) => void;
}) {
  const alreadyActive =
    row.operation === "CANDIDATE" && row.bundleId === activeCandidateId;
  const canRollback =
    row.status === "RETIRED" &&
    row.operation !== "CANDIDATE" &&
    row.bundleId !== activeReleaseId;
  return (
    <tr>
      <td>
        {new Date(row.createdAt).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })}
      </td>
      <td>
        <strong>{row.bundleId}</strong>
        <div className="secondary">
          {row.sourceCandidateBundleId ?? "候选记录"}
        </div>
      </td>
      <td>
        {row.operation === "CANDIDATE"
          ? "候选校验"
          : row.operation === "ACTIVATE"
            ? "发布"
            : "回滚"}
      </td>
      <td>
        <span className={`status-label ${row.status.toLowerCase()}`}>
          {statusLabels[row.status]}
        </span>
      </td>
      <td>{row.blockerCodes.length}</td>
      <td title={row.manifestSha256}>
        <code>{row.manifestSha256.slice(0, 12)}</code>
      </td>
      <td>
        {!canManage ? (
          "—"
        ) : row.operation === "CANDIDATE" ? (
          <Button
            disabled={alreadyActive || pending}
            onClick={() => {
              if (
                window.confirm(`激活 ${row.bundleId} 为活动影子版本？`)
              ) {
                onActivate(row);
              }
            }}
          >
            <Rocket size={16} />
            {alreadyActive ? "已激活" : "激活"}
          </Button>
        ) : canRollback ? (
          <Button
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  `回滚至 ${row.bundleId}？当前账本不会改变。`,
                )
              ) {
                onRollback(row);
              }
            }}
          >
            <RotateCcw size={16} />
            回滚
          </Button>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
