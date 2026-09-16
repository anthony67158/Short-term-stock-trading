import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check } from "lucide-react";
import { Button, Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

const severityLabels = {
  INFO: "信息",
  ACTION: "待处理",
  WARNING: "警告",
} as const;

export function Inbox() {
  const cache = useQueryClient();
  const inbox = useQuery({
    queryKey: ["notifications"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/notifications", {
        params: { query: { limit: 100 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    refetchInterval: 5000,
  });
  const markRead = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.POST("/api/v1/notifications/{notification_id}/read", {
        params: { path: { notification_id: id } },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const rows = inbox.data?.notifications ?? [];
  return <>
    <header className="workspace-header">
      <h1>收件箱</h1>
      <span className="secondary">{inbox.data?.unreadCount ?? 0} 条未读</span>
    </header>
    <div className="workspace-content">
      <section className="ledger-section">
        <div className="section-toolbar">
          <h2>系统事项</h2>
          <Button onClick={() => inbox.refetch()} disabled={inbox.isFetching}>刷新</Button>
        </div>
        {inbox.isPending ? <p role="status">正在读取通知…</p>
          : inbox.isError ? <p role="alert" className="error">{errorMessage(inbox.error)}</p>
            : rows.length === 0 ? <Empty title="暂无通知"><Bell size={20} />联合决策、监控和计划事件会出现在这里。</Empty>
              : <div className="table-scroll" role="region" aria-label="通知收件箱，可横向滚动" tabIndex={0}>
                <table>
                  <thead><tr><th>时间</th><th>级别</th><th>事项</th><th>状态</th><th>操作</th></tr></thead>
                  <tbody>{rows.map((row) => <tr key={row.id}>
                    <td>{new Date(row.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</td>
                    <td>{severityLabels[row.severity]}</td>
                    <td><strong>{row.title}</strong><div className="secondary">{row.message}</div></td>
                    <td>{row.readAt ? "已读" : "未读"}</td>
                    <td>{row.readAt ? "—" : <Button
                      className="icon-button"
                      aria-label={`标记已读：${row.title}`}
                      title="标记已读"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(row.id)}
                    ><Check size={16} /></Button>}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
        {markRead.isError && <p role="alert" className="error">{errorMessage(markRead.error)}</p>}
      </section>
    </div>
  </>;
}
