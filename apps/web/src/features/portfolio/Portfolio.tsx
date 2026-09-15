import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useSearchParams } from "react-router";
import type { components } from "../../../../../packages/api-client/schema";
import { api, errorMessage } from "../../lib/api";
import { Button, Empty, Input } from "../../components/Controls";
import { Executions } from "./Executions";
import { Reconciliation } from "./Reconciliation";
import { ExecutionImport } from "./ExecutionImport";
import { Plans } from "./Plans";
import { OpeningLots } from "./OpeningLots";

type Account = components["schemas"]["AccountView"];
type CashInput = components["schemas"]["CashFlowInput"];
const cashLabels = { OPENING: "期初余额", DEPOSIT: "入金", WITHDRAWAL: "出金", EXECUTION: "成交结算", REVERSAL: "成交冲正" };
const money = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// A network retry must reuse the exact command. Edits intentionally create a new command.
function useCommandKey() {
  const saved = useRef({ body: "", key: "" });
  return (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (saved.current.body !== serialized) saved.current = { body: serialized, key: crypto.randomUUID() };
    return saved.current.key;
  };
}

function CreateAccount({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const commandKey = useCommandKey();
  const mutation = useMutation({
    mutationFn: async (body: components["schemas"]["AccountInput"]) => {
      const result = await api.POST("/api/v1/accounts", { body, params: { header: { "Idempotency-Key": commandKey(body) } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: (account) => onCreated(account.id),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({
      name: String(data.get("name")).trim(), kind: data.get("kind") as "REAL" | "SIMULATED",
      maxPositionPercent: Number(data.get("risk")), currency: "CNY",
    });
  }
  return <section className="editor-section"><h2>创建投资账户</h2>
    <p className="secondary">实盘与模拟独立记账。单股上限用于后续计划约束。</p>
    <form className="inline-form" onSubmit={submit}>
      <Input id="account-name" label="账户名称" name="name" maxLength={80} required autoFocus />
      <label className="field"><span>账户类型</span><select name="kind" defaultValue="SIMULATED"><option value="SIMULATED">模拟账户</option><option value="REAL">实盘账户</option></select></label>
      <Input id="account-risk" label="单股仓位上限（%）" name="risk" type="number" min={1} max={100} step={1} required defaultValue={20} />
      <div className="form-actions"><Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "正在创建…" : "创建账户"}</Button><Button type="button" onClick={onCancel}>取消</Button></div>
      {mutation.isError && <p className="error" role="alert">{errorMessage(mutation.error)}</p>}
    </form>
  </section>;
}

function CashEditor({ account, onSaved, onCancel }: { account: Account; onSaved: () => void; onCancel: () => void }) {
  const commandKey = useCommandKey();
  const submittedTime = useRef("");
  const mutation = useMutation({
    mutationFn: async (body: CashInput) => {
      const result = await api.POST("/api/v1/accounts/{account_id}/cash-flows", {
        params: { path: { account_id: account.id }, header: { "Idempotency-Key": commandKey(body) } }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data;
    }, onSuccess: onSaved,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const entered = String(data.get("time"));
    if (!submittedTime.current) submittedTime.current = new Date().toISOString();
    mutation.mutate({
      kind: data.get("kind") as CashInput["kind"], amount: String(data.get("amount")),
      source: String(data.get("source")).trim(), expectedVersion: account.version,
      effectiveAt: entered ? new Date(entered).toISOString() : submittedTime.current,
    });
  }
  return <section className="editor-section"><h2>录入资金变动</h2>
    <p className="secondary">按实际发生时间顺序录入。金额填写正数，出金会扣减现金。</p>
    <form className="inline-form" onSubmit={submit}>
      <label className="field"><span>资金类型</span><select name="kind" defaultValue={account.version === 1 ? "OPENING" : "DEPOSIT"}>
        {account.version === 1 && <option value="OPENING">期初余额</option>}<option value="DEPOSIT">入金</option><option value="WITHDRAWAL">出金</option>
      </select></label>
      <Input id="cash-amount" label="金额（元）" name="amount" type="text" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required autoFocus />
      <Input id="cash-time" label="发生时间（留空为当前时间）" name="time" type="datetime-local" />
      <Input id="cash-source" label="凭据或来源说明" name="source" maxLength={300} required />
      <div className="form-actions"><Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "正在保存…" : "保存资金记录"}</Button><Button type="button" onClick={onCancel}>取消</Button></div>
      {mutation.isError && <p className="error" role="alert">{errorMessage(mutation.error)}</p>}
    </form>
  </section>;
}

function AccountLedger({ accountId }: { accountId: string }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const balance = useQuery({
    queryKey: ["balance", accountId],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/balance", { params: { path: { account_id: accountId } }, signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const history = useInfiniteQuery({
    queryKey: ["cash", accountId], initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/cash-flows", {
        params: { path: { account_id: accountId }, query: { cursor: pageParam, limit: 30 } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ? Number(last.nextCursor) : undefined,
  });
  if (balance.isPending) return <p role="status">正在读取账户余额…</p>;
  if (balance.isError) return <div role="alert"><p>{errorMessage(balance.error)}</p><Button onClick={() => balance.refetch()}>重新读取</Button></div>;
  const { account, cashBalance } = balance.data;
  const rows = history.data?.pages.flatMap((page) => page.entries) ?? [];
  return <>
    <div className="account-summary">
      <div><span className="secondary">现金余额 · 人民币</span><strong className="balance-value">{money(cashBalance)}</strong></div>
      <div><span className="secondary">账户类型</span><strong>{account.kind === "SIMULATED" ? "模拟账户" : "实盘账户"}</strong></div>
      <div><span className="secondary">单股仓位上限</span><strong>{account.maxPositionPercent}%</strong></div>
      <Button onClick={() => { setEditing(true); setSaved(false); }} disabled={editing}><Plus size={16} />录入资金</Button>
    </div>
    {saved && <p role="status" className="save-notice">资金记录已保存，余额已更新。</p>}
    {editing && <CashEditor account={account} onCancel={() => setEditing(false)} onSaved={async () => {
      setEditing(false); setSaved(true);
      await cache.invalidateQueries({ queryKey: ["balance", accountId] });
      await cache.invalidateQueries({ queryKey: ["cash", accountId] });
      await cache.invalidateQueries({ queryKey: ["plans", accountId] });
      await cache.invalidateQueries({ queryKey: ["accounts"] });
    }} />}
    <OpeningLots account={account} />
    <Executions account={account} />
    <Plans account={account} />
    <ExecutionImport account={account} />
    <section className="ledger-section"><h2>资金流水</h2>
      {history.isPending ? <p role="status">正在读取资金流水…</p> : history.isError ? <div role="alert"><p>{errorMessage(history.error)}</p><Button onClick={() => history.refetch()}>重新读取</Button></div>
        : rows.length === 0 ? <Empty title="尚无资金记录">录入期初余额或第一笔入金，开始建立账户账本。</Empty>
          : <div className="table-scroll" tabIndex={0} role="region" aria-label="资金流水，可横向滚动"><table><thead><tr><th>发生时间</th><th>类型</th><th className="numeric">金额（元）</th><th>凭据 / 来源</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
            <td>{new Date(row.effectiveAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</td><td>{cashLabels[row.kind]}</td><td className="numeric">{money(row.amount)}</td><td>{row.source}</td>
          </tr>)}</tbody></table></div>}
      {history.hasNextPage && <Button disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>加载更早记录</Button>}
    </section>
    <Reconciliation accountId={account.id} version={account.version} />
  </>;
}

export function Portfolio() {
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get("account") ?? "";
  function setSelected(id: string) {
    setParams((previous) => {
      previous.set("account", id); previous.delete("import"); return previous;
    });
  }
  const [creating, setCreating] = useState(false);
  const accounts = useInfiniteQuery({
    queryKey: ["accounts"], initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts", { params: { query: { cursor: pageParam } }, signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = accounts.data?.pages.flatMap((page) => page.accounts) ?? [];
  const accountId = selected || rows[0]?.id;
  return <><header className="workspace-header"><h1>组合与执行</h1><Button onClick={() => setCreating(true)}><Plus size={16} />创建账户</Button></header>
    <div className="workspace-content">
      {creating && <CreateAccount onCancel={() => setCreating(false)} onCreated={async (id) => {
        setSelected(id); setCreating(false); await cache.invalidateQueries({ queryKey: ["accounts"] });
      }} />}
      {accounts.isPending ? <p role="status">正在读取投资账户…</p> : accounts.isError ? <div role="alert"><p>{errorMessage(accounts.error)}</p><Button onClick={() => accounts.refetch()}>重新读取</Button></div> : <>
        {rows.length > 0 && <div className="account-picker"><label className="field"><span>当前账户</span><select value={accountId} onChange={(event) => setSelected(event.target.value)}>{rows.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.kind === "SIMULATED" ? "模拟" : "实盘"}</option>)}</select></label>
          {accounts.hasNextPage && <Button onClick={() => accounts.fetchNextPage()} disabled={accounts.isFetchingNextPage}>更多账户</Button>}</div>}
        {accountId ? <AccountLedger key={accountId} accountId={accountId} /> : !creating && <Empty title="建立你的第一个投资账户">创建实盘或模拟账户，分别记录资金与投资活动。</Empty>}
      </>}
    </div>
  </>;
}
