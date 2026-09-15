import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Input } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Account = components["schemas"]["AccountView"];
type Plan = components["schemas"]["PlanView"];
const labels = { CONFIRMED: "已确认 · 待记录", PARTIALLY_RECORDED: "部分成交已记录", COMPLETED: "成交已记录完毕", CANCELLED: "已取消", EXPIRED: "已到期", INVALIDATED: "账户变化，计划失效" };

export function Plans({ account }: { account: Account }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState<Plan | null>(null);
  const command = useRef({ body: "", key: "" });
  function commandKey(body: unknown) {
    const text = JSON.stringify(body);
    if (text !== command.current.body) command.current = { body: text, key: crypto.randomUUID() };
    return command.current.key;
  }
  async function refresh() {
    for (const key of ["plans", "balance"])
      await cache.invalidateQueries({ queryKey: [key, account.id] });
    setEditing(false); setCancelling(null);
  }
  const history = useInfiniteQuery({
    queryKey: ["plans", account.id], initialPageParam: undefined as string | undefined, refetchInterval: 15_000,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/plans", {
        params: { path: { account_id: account.id }, query: { cursor: pageParam, limit: 30 } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: async (body: components["schemas"]["PlanInput"]) => {
      const result = await api.POST("/api/v1/accounts/{account_id}/plans", {
        params: { path: { account_id: account.id }, header: { "Idempotency-Key": commandKey(body) } }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: async (reason: string) => {
      if (!cancelling) throw new Error("请先选择计划");
      const body = { reason, expectedRevision: cancelling.revision, expectedVersion: account.version };
      const result = await api.POST("/api/v1/accounts/{account_id}/plans/{plan_id}/cancellations", {
        params: { path: { account_id: account.id, plan_id: cancelling.id }, header: { "Idempotency-Key": commandKey({ plan: cancelling.id, ...body }) } }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, onSuccess: refresh,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key)).trim();
    create.mutate({
      instrumentId: `${value("exchange")}.${value("code")}`, side: value("side") as "BUY" | "SELL",
      quantityShares: Number(value("quantity")), limitPrice: value("price"), feeBudget: value("fees"),
      expiresAt: new Date(value("expiry")).toISOString(), reason: value("reason"), expectedVersion: account.version,
    });
  }
  const summary = history.data?.pages[0];
  useEffect(() => {
    if (summary && summary.accountVersion > account.version)
      void cache.invalidateQueries({ queryKey: ["balance", account.id] });
  }, [summary?.accountVersion, account.version, account.id, cache]);
  const rows = history.data?.pages.flatMap((page) => page.plans) ?? [];
  return <section className="ledger-section">
    <div className="section-toolbar"><h2>人工计划与预留</h2><Button onClick={() => { create.reset(); setEditing(true); }} disabled={editing}>创建人工计划</Button></div>
    <p className="source-note">确认只预留账本资源，不代表券商报单。当前为自主人工计划，尚未评估行情、权限或仓位风险，不是系统投资建议。</p>
    {summary && <p>计划预留：{summary.reservedCash} 元 · 可支配现金：{summary.spendableCash} 元</p>}
    {create.isSuccess && !editing && <p role="status" className="save-notice">计划已确认，现金与持仓事实未改变。</p>}
    {editing && <form className="inline-form" onSubmit={submit}>
      <label className="field"><span>计划市场</span><select name="exchange"><option value="SZ">深圳</option><option value="SH">上海</option><option value="BJ">北京</option></select></label>
      <Input id="plan-code" label="计划证券代码" name="code" pattern="\d{6}" required autoFocus />
      <label className="field"><span>计划方向</span><select name="side"><option value="BUY">买入</option><option value="SELL">卖出</option></select></label>
      <Input id="plan-quantity" label="计划股数" name="quantity" type="number" min={1} step={1} required />
      <Input id="plan-price" label="计划限价（元）" name="price" pattern="\d+(\.\d{1,2})?" inputMode="decimal" required />
      <Input id="plan-fees" label="费用预留预算（元）" name="fees" pattern="\d+(\.\d{1,2})?" inputMode="decimal" required />
      <Input id="plan-expiry" label="计划到期时间（本设备时区，当日内）" name="expiry" type="datetime-local" step={1} required />
      <Input id="plan-reason" label="计划依据" name="reason" maxLength={300} required />
      <div className="form-actions"><Button type="submit" variant="primary" disabled={create.isPending}>{create.isPending ? "正在预留…" : "确认人工计划并预留"}</Button><Button type="button" onClick={() => setEditing(false)} disabled={create.isPending}>放弃创建</Button></div>
      {create.isError && <p className="error" role="alert">{errorMessage(create.error)}</p>}
    </form>}
    {history.isPending ? <p role="status">正在读取计划…</p> : history.isError ? <div role="alert">{errorMessage(history.error)}<Button onClick={() => history.refetch()}>重读计划</Button></div>
      : rows.length === 0 ? <p className="secondary">尚无计划。</p> :
        <div className="table-scroll" role="region" aria-label="人工计划，可横向滚动" tabIndex={0}><table>
          <thead><tr><th>股票 / 方向</th><th>已记录 / 计划股数</th><th>预留现金 / 股数</th><th>状态</th><th>关联编号</th><th>操作</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td>{row.instrumentId} · {row.side === "BUY" ? "买入" : "卖出"}</td><td>{row.recordedShares} / {row.quantityShares}</td><td>{row.reservedCash} 元 / {row.reservedShares} 股</td><td>{labels[row.status]}</td><td>{row.id}</td><td>{["CONFIRMED", "PARTIALLY_RECORDED"].includes(row.status) ? <Button onClick={() => { cancel.reset(); setCancelling(row); }}>取消计划</Button> : "—"}</td></tr>)}</tbody>
        </table></div>}
    {history.hasNextPage && <Button disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>更多计划</Button>}
    {cancelling && <form className="inline-form" onSubmit={(event) => { event.preventDefault(); cancel.mutate(String(new FormData(event.currentTarget).get("reason")).trim()); }}>
      <Input id="plan-cancel-reason" label="取消计划原因" name="reason" required maxLength={300} autoFocus />
      <div className="form-actions"><Button type="submit" disabled={cancel.isPending}>确认取消并释放剩余预留</Button><Button type="button" onClick={() => setCancelling(null)}>保留计划</Button></div>
      {cancel.isError && <p role="alert" className="error">{errorMessage(cancel.error)}</p>}
    </form>}
  </section>;
}
