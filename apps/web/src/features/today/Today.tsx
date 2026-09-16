import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  FlaskConical,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { Link } from "react-router";
import { Button, Empty } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

function shanghaiDay() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "full",
  }).format(new Date());
}

export function Today() {
  const accounts = useQuery({
    queryKey: ["today", "accounts"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/accounts", {
        params: { query: { limit: 10 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.accounts;
    },
  });
  const notifications = useQuery({
    queryKey: ["today", "notifications"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/notifications", {
        params: { query: { limit: 8 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const releases = useQuery({
    queryKey: ["today", "releases"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/releases", {
        params: { query: { limit: 20 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const reviews = useQuery({
    queryKey: ["today", "reviews"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/reviews", {
        params: { query: { limit: 1 } },
        signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.reports;
    },
  });
  const queries = [accounts, notifications, releases, reviews];
  const pending = queries.some((query) => query.isPending);
  const error = queries.find((query) => query.error)?.error;
  const active = releases.data?.releases.find(
    (release) =>
      release.status === "ACTIVE"
      && release.bundleId === releases.data.activeReleaseId,
  );
  const latestReview = reviews.data?.[0];
  const refresh = () =>
    Promise.all(queries.map((query) => query.refetch()));
  return (
    <>
      <header className="workspace-header">
        <div>
          <h1>今日工作台</h1>
          <span className="secondary">{shanghaiDay()}</span>
        </div>
        <Button
          className="icon-button"
          aria-label="刷新今日工作台"
          title="刷新"
          disabled={pending}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </Button>
      </header>
      <div className="workspace-content">
        {pending ? (
          <p role="status">正在读取今日状态…</p>
        ) : error ? (
          <div role="alert">
            <p className="error">{errorMessage(error)}</p>
            <Button onClick={() => void refresh()}>重新读取</Button>
          </div>
        ) : (
          <>
            <section className="today-status" aria-label="平台状态">
              <div>
                <span className="secondary">活动联合包</span>
                <strong>{releases.data?.activeReleaseId ?? "无"}</strong>
                <small>
                  {active
                    ? `${active.deploymentMode} · ${active.blockerCodes.length} 项门禁`
                    : "未登记活动发布"}
                </small>
              </div>
              <div>
                <span className="secondary">待处理事项</span>
                <strong>{notifications.data?.unreadCount ?? 0}</strong>
                <small>按风险与时效进入收件箱</small>
              </div>
              <div>
                <span className="secondary">投资账户</span>
                <strong>{accounts.data?.length ?? 0}</strong>
                <small>实盘与模拟分别记账</small>
              </div>
              <div>
                <span className="secondary">最近复盘</span>
                <strong>{latestReview?.reviewDate ?? "暂无"}</strong>
                <small>
                  {latestReview
                    ? `${latestReview.proposals.length} 项实验提案`
                    : "等待前瞻样本成熟"}
                </small>
              </div>
            </section>
            <div className="today-columns">
              <section className="today-section" aria-labelledby="today-actions">
                <div className="section-toolbar">
                  <h2 id="today-actions">待处理事项</h2>
                  <Link to="/inbox">
                    查看收件箱 <ArrowRight size={14} />
                  </Link>
                </div>
                {(notifications.data?.notifications.length ?? 0) === 0 ? (
                  <Empty title="暂无待处理事项">
                    <Bell size={18} />
                    新决策、监控和执行事件会出现在这里。
                  </Empty>
                ) : (
                  <div className="today-list">
                    {notifications.data?.notifications.map((item) => (
                      <article key={item.id}>
                        <span
                          className={`status-label ${item.severity.toLowerCase()}`}
                        >
                          {item.severity}
                        </span>
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.message}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <section className="today-section" aria-labelledby="today-work">
                <h2 id="today-work">继续工作</h2>
                <nav className="today-links" aria-label="今日快捷入口">
                  <Link to="/portfolio">
                    <Wallet size={17} />
                    <span>
                      <strong>组合与执行</strong>
                      <small>核对持仓、计划与真实成交</small>
                    </span>
                    <ArrowRight size={15} />
                  </Link>
                  <Link to="/market">
                    <FlaskConical size={17} />
                    <span>
                      <strong>市场与选股</strong>
                      <small>运行联合扫描并进入证据研究</small>
                    </span>
                    <ArrowRight size={15} />
                  </Link>
                  <Link to="/review">
                    <Bell size={17} />
                    <span>
                      <strong>复盘与洞察</strong>
                      <small>查看失败簇、漂移和实验提案</small>
                    </span>
                    <ArrowRight size={15} />
                  </Link>
                </nav>
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}
