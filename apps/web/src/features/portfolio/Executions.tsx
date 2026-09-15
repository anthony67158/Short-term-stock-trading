import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Empty, Input } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Account = components["schemas"]["AccountView"];
type ExecutionInput = components["schemas"]["ExecutionInput"];
const timestamp = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

function ExecutionEditor({ account, saved, cancel }: { account: Account; saved: () => void; cancel: () => void }) {
  const command = useRef({ body: "", key: "" });
  const mutation = useMutation({
    mutationFn: async (body: ExecutionInput) => {
      const serialized = JSON.stringify(body);
      if (serialized !== command.current.body) command.current = { body: serialized, key: crypto.randomUUID() };
      const result = await api.POST("/api/v1/accounts/{account_id}/executions", {
        params: { path: { account_id: account.id }, header: { "Idempotency-Key": command.current.key } }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, onSuccess: saved,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key)).trim();
    mutation.mutate({
      instrumentId: `${value("exchange")}.${value("code")}`, side: value("side") as "BUY" | "SELL",
      quantityShares: Number(value("quantity")), price: value("price"),
      executedAt: new Date(value("time")).toISOString(), sourceKey: value("reference"),
      source: value("source"), expectedVersion: account.version,
      fees: { commission: value("commission"), stampTax: value("stamp"), transferFee: value("transfer"), otherFee: value("other"), basis: "ACTUAL" },
    });
  }
  return <section className="editor-section"><h2>录入成交事实</h2>
    <p className="secondary">按交割单逐笔录入，时间按本设备时区填写。实际费用请核对凭据；同一订单的部分成交不要重复填入整单费用。</p>
    <form className="inline-form" onSubmit={submit}>
      <label className="field"><span>交易市场</span><select name="exchange" defaultValue="SZ"><option value="SZ">深圳</option><option value="SH">上海</option><option value="BJ">北京</option></select></label>
      <Input id="execution-code" label="证券代码（6位）" name="code" pattern="\d{6}" required autoFocus />
      <label className="field"><span>成交方向</span><select name="side"><option value="BUY">买入</option><option value="SELL">卖出</option></select></label>
      <Input id="execution-quantity" label="实际成交股数" name="quantity" type="number" min={1} max={1_000_000_000} step={1} required />
      <Input id="execution-price" label="成交价格（元）" name="price" inputMode="decimal" pattern="\d+(\.\d{1,4})?" required />
      <Input id="execution-time" label="成交时间" name="time" type="datetime-local" step={1} required />
      <Input id="execution-commission" label="实际佣金（元）" name="commission" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required />
      <Input id="execution-stamp" label="实际印花税（元）" name="stamp" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required />
      <Input id="execution-transfer" label="实际过户费（元）" name="transfer" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required />
      <Input id="execution-other" label="其他实际费用（元）" name="other" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required />
      <Input id="execution-reference" label="交割编号（账户内唯一）" name="reference" maxLength={128} required />
      <Input id="execution-source" label="成交凭据说明" name="source" maxLength={300} required />
      <div className="form-actions"><Button variant="primary" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "正在记账…" : "保存成交事实"}</Button><Button type="button" onClick={cancel}>取消</Button></div>
      {mutation.isError && <p role="alert" className="error">{errorMessage(mutation.error)}</p>}
    </form>
  </section>;
}

export function Executions({ account }: { account: Account }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const positions = useInfiniteQuery({
    queryKey: ["positions", account.id], initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/positions", {
        params: { path: { account_id: account.id }, query: { cursor: pageParam, limit: 30 } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
  const history = useInfiniteQuery({
    queryKey: ["executions", account.id], initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/executions", {
        params: { path: { account_id: account.id }, query: { cursor: pageParam, limit: 30 } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ? Number(last.nextCursor) : undefined,
  });
  const rows = positions.data?.pages.flatMap((p) => p.positions) ?? [];
  const trades = history.data?.pages.flatMap((p) => p.executions) ?? [];
  return <>
    <section className="ledger-section">
      <div className="section-toolbar"><h2>持仓</h2><Button onClick={() => { setEditing(true); setSaved(false); }} disabled={editing}>录入成交</Button></div>
      <p className="source-note">成本按先进先出、含实际买入费用计算；可卖股数已扣除当日买入锁定。当前尚未计入计划预留。</p>
      {saved && <p role="status" className="save-notice">成交已记账，持仓与现金已更新。</p>}
      {editing && <ExecutionEditor account={account} cancel={() => setEditing(false)} saved={async () => {
        setEditing(false); setSaved(true);
        for (const key of ["balance", "cash", "positions", "executions"])
          await cache.invalidateQueries({ queryKey: [key, account.id] });
      }} />}
      {positions.isPending ? <p role="status">正在读取持仓…</p> : positions.isError ? <div role="alert">{errorMessage(positions.error)}<Button onClick={() => positions.refetch()}>重新读取持仓</Button></div>
        : rows.length === 0 ? <Empty title="尚无持仓">录入已有成交后，持仓将按实际股数建立。</Empty>
          : <div className="table-scroll" role="region" aria-label="持仓明细，可横向滚动" tabIndex={0}><table><thead><tr><th>股票</th><th className="numeric">持有 / 可卖（股）</th><th className="numeric">当日锁定（股）</th><th className="numeric">剩余含费成本（元）</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.instrumentId}><td><Link to={`/research/${row.instrumentId}`}>{row.name}</Link><div className="secondary">{row.instrumentId}</div></td><td className="numeric">{row.quantityShares} / {row.sellableShares}</td><td className="numeric">{row.lockedShares}</td><td className="numeric">{row.remainingBasis}</td></tr>)}</tbody></table></div>}
      {positions.hasNextPage && <Button disabled={positions.isFetchingNextPage} onClick={() => positions.fetchNextPage()}>更多持仓</Button>}
    </section>
    <section className="ledger-section"><h2>成交记录</h2>
      {history.isPending ? <p role="status">正在读取成交…</p> : history.isError ? <div role="alert">{errorMessage(history.error)}<Button onClick={() => history.refetch()}>重新读取成交</Button></div>
        : trades.length === 0 ? <p className="secondary">尚无已记录成交。</p>
          : <div className="table-scroll" role="region" aria-label="成交明细，可横向滚动" tabIndex={0}><table><thead><tr><th>时间 / 交割编号</th><th>股票 / 方向</th><th className="numeric">股数 × 价格</th><th className="numeric">费用（元）</th><th className="numeric">现金变动（元）</th><th className="numeric">已实现盈亏（元）</th></tr></thead>
            <tbody>{trades.map((row) => <tr key={row.id}><td>{timestamp(row.executedAt)}<div className="secondary">{row.sourceKey}</div></td><td>{row.instrumentId} · {row.side === "BUY" ? "买入" : "卖出"}</td><td className="numeric">{row.quantityShares} × {row.price}</td><td className="numeric">{row.totalFees}</td><td className="numeric">{row.cashDelta}</td><td className="numeric">{row.realizedPnl ?? "—"}</td></tr>)}</tbody></table></div>}
      {history.hasNextPage && <Button disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>更早成交</Button>}
    </section>
  </>;
}
