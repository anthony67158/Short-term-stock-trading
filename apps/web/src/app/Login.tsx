import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChartNoAxesCombined } from "lucide-react";
import { Button, Input } from "../components/Controls";
import { api, errorMessage } from "../lib/api";

export function Login() {
  const cache = useQueryClient();
  const login = useMutation({
    mutationFn: async (body: { username: string; password: string }) => {
      const result = await api.POST("/api/v1/sessions", { body });
      if (!result.data) throw result.error;
      return result.data.data;
    },
    onSuccess: (user) => {
      cache.clear();
      cache.setQueryData(["session"], user);
    },
  });
  return <main className="login">
    <div className="login-intro">
      <div className="brand"><ChartNoAxesCombined size={24} /><span>知衡</span><small>INVESTMENT WORKSPACE</small></div>
      <div><p className="eyebrow">A 股 · 投资工作台</p><h1>让每一次决策，<br />都有据可循。</h1>
        <p className="login-description">连接市场研究、量化预测与持仓管理。<br />从投资论点到真实成交，保留完整的判断依据。</p></div>
      <p className="secondary">研究 → 决策 → 执行 → 复盘</p>
    </div>
    <section className="login-form">
      <h2>进入工作区</h2><p className="secondary">登录后查看您的研究与投资账户。</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        login.mutate({ username: String(form.get("username")), password: String(form.get("password")) });
      }}>
        <Input label="用户名" id="username" name="username" autoComplete="username" required maxLength={80} />
        <Input label="密码" id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
        {login.isError && <p className="error" role="alert">{errorMessage(login.error)}</p>}
        <Button variant="primary" disabled={login.isPending}>{login.isPending ? "正在登录…" : "登录工作区"}<ArrowRight size={16} /></Button>
      </form>
      <p className="login-footnote">账户由工作区管理员创建。您的成交仅在人工录入后记账。</p>
    </section>
  </main>;
}
