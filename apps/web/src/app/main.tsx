import { Component, StrictMode, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { ChartNoAxesCombined, CircleHelp, Compass, FlaskConical, LayoutDashboard, LogOut, Moon, NotebookPen, Sun, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { Button, Empty } from "../components/Controls";
import { Login } from "./Login";
import "../styles/global.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });
const navigation = [
  { path: "/", label: "今日工作台", icon: LayoutDashboard },
  { path: "/market", label: "市场与选股", icon: Compass },
  { path: "/research", label: "股票研究", icon: NotebookPen },
  { path: "/portfolio", label: "组合与执行", icon: Wallet },
  { path: "/strategies", label: "策略实验室", icon: FlaskConical },
  { path: "/review", label: "复盘与洞察", icon: ChartNoAxesCombined },
];

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* No private data in console. */ }
  render() {
    return this.state.failed ? <main className="empty"><h1>页面暂时无法显示</h1><p>请刷新页面重试，已保存的账户记录不受影响。</p><Button onClick={() => location.reload()}>刷新</Button></main> : this.props.children;
  }
}

function Workspace() {
  const cache = useQueryClient();
  const [theme, setTheme] = useState(() => localStorage.getItem("platform-theme") || "dark");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("platform-theme", theme); }, [theme]);
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/sessions/current", { signal });
      if (result.response.status === 401) return null;
      if (!result.data) throw new Error("无法连接工作区");
      return result.data.data;
    },
  });
  if (session.isPending) return <main className="empty" role="status">正在连接工作区…</main>;
  if (session.isError) return <main className="empty"><h1>工作区暂时无法连接</h1><Button onClick={() => session.refetch()}>重新连接</Button></main>;
  if (!session.data) return <Login />;
  return <div className="shell">
    <a className="skip" href="#main">跳转到主内容</a>
    <aside className="sidebar">
      <div className="brand"><ChartNoAxesCombined size={20} /><span>知衡</span><small>工作区</small></div>
      <nav aria-label="主要导航">{navigation.map(({ path, label, icon: Icon }) =>
        <NavLink key={path} to={path} end><Icon size={17} />{label}</NavLink>)}</nav>
      <div className="sidebar-bottom"><span className="secondary">{session.data.username}</span>
        <div className="control-group"><Button className="icon-button" aria-label="切换深浅主题" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</Button>
          <Button className="icon-button" aria-label="退出登录" onClick={async () => {
            const result = await api.DELETE("/api/v1/sessions/current");
            if (result.response.ok) { await cache.cancelQueries(); cache.clear(); cache.setQueryData(["session"], null); }
          }}><LogOut size={16} /></Button></div>
      </div>
    </aside>
    <main id="main" className="workspace"><Routes>
      {navigation.map(({ path, label }) => <Route key={path} path={path} element={<>
        <header className="workspace-header"><h1>{label}</h1><span className="secondary">研究与账户工作区</span></header>
        <div className="workspace-content"><Empty title="此工作区正在建设"><CircleHelp size={20} />模块接入后将在这里展示真实数据与任务结果。</Empty></div>
      </>} />)}
    </Routes></main>
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ErrorBoundary><QueryClientProvider client={client}><BrowserRouter><Workspace /></BrowserRouter></QueryClientProvider></ErrorBoundary></StrictMode>,
);
