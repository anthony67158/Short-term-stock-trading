import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Input } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Account = components["schemas"]["AccountView"];
type Trade = components["schemas"]["ExecutionView"];
type Replacement = components["schemas"]["ReplacementFact"];

export function CorrectionEditor({ account, trade, close }: { account: Account; trade: Trade; close: () => void }) {
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("VOID");
  const [quantity, setQuantity] = useState(String(trade.quantityShares));
  const [price, setPrice] = useState(trade.price);
  const [fees, setFees] = useState(trade.fees);
  const replacement: Replacement | null = mode === "REPLACE" ? { quantityShares: Number(quantity), price, fees } : null;
  const input = { reason: reason.trim(), expectedVersion: account.version, replacement };
  const key = useRef(crypto.randomUUID());
  const path = { account_id: account.id, execution_id: trade.id };
  const preview = useMutation({
    mutationFn: async (body: typeof input) => {
      const result = await api.POST("/api/v1/accounts/{account_id}/executions/{execution_id}/correction-previews", {
        params: { path }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return { ...result.data.data, input: body };
    },
  });
  const commit = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("请先核对冲正影响");
      const result = await api.POST("/api/v1/accounts/{account_id}/executions/{execution_id}/corrections", {
        params: { path, header: { "Idempotency-Key": key.current } },
        body: { ...preview.data.input, previewHash: preview.data.previewHash },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      for (const query of ["balance", "cash", "positions", "executions", "corrections", "plans"])
        await cache.invalidateQueries({ queryKey: [query, account.id] });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    key.current = crypto.randomUUID();
    commit.reset();
    preview.mutate(input);
  }
  const valid = JSON.stringify(preview.data?.input) === JSON.stringify(input);
  return <section className="editor-section" aria-label="成交冲正">
    <h3>冲正这笔成交</h3>
    <p>{trade.instrumentId} · {trade.side === "BUY" ? "买入" : "卖出"} {trade.quantityShares} 股 × {trade.price} 元 · 交割编号 {trade.sourceKey}</p>
    <p className="secondary">保留原始凭据。可整笔作废，或按修订凭据更正股数、价格与费用，重算后续现金、持仓和盈亏；股票、方向及发生时间保持原记录。</p>
    {commit.isSuccess ? <><p role="status" className="save-notice">成交已冲正，持仓与现金已更新，原始凭据已保留。</p><Button onClick={close}>关闭冲正结果</Button></> :
      <form className="inline-form" onSubmit={submit}>
        <label className="field"><span>冲正方式</span><select value={mode} onChange={(event) => setMode(event.target.value)} disabled={commit.isPending}>
          <option value="VOID">整笔误录作废</option><option value="REPLACE">更正股数、价格或费用</option>
        </select></label>
        <Input id="correction-reason" label="冲正原因" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required autoFocus disabled={commit.isPending} />
        {mode === "REPLACE" && <>
          <Input id="correction-quantity" label="更正后股数" type="number" min={1} max={1_000_000_000} step={1} value={quantity} onChange={(event) => setQuantity(event.target.value)} required disabled={commit.isPending} />
          <Input id="correction-price" label="更正后价格（元）" inputMode="decimal" pattern="\d+(\.\d{1,4})?" value={price} onChange={(event) => setPrice(event.target.value)} required disabled={commit.isPending} />
          {([["commission", "佣金"], ["stampTax", "印花税"], ["transferFee", "过户费"], ["otherFee", "其他费用"]] as const).map(([name, label]) =>
            <Input key={name} id={`correction-${name}`} label={`更正后实际${label}（元）`} inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={fees[name]} onChange={(event) => setFees({ ...fees, [name]: event.target.value })} required disabled={commit.isPending} />)}
        </>}
        <div className="form-actions"><Button type="submit" disabled={preview.isPending || commit.isPending}>{preview.isPending ? "正在核对…" : "预览冲正影响"}</Button><Button type="button" onClick={close} disabled={commit.isPending}>取消冲正</Button></div>
        {preview.data && <div className="form-actions">
          <p>现金：{preview.data.cashBefore} → {preview.data.cashAfter} 元；持仓总股数：{preview.data.openSharesBefore} → {preview.data.openSharesAfter}；重算盈亏：{preview.data.recalculatedSales} 笔卖出。</p>
          {!valid && <p role="status">账户或更正内容已变化，请重新预览。</p>}
          <Button type="button" variant="primary" disabled={!valid || commit.isPending || preview.isPending} onClick={() => commit.mutate()}>{commit.isPending ? "正在冲正…" : "确认冲正这笔成交"}</Button>
        </div>}
        {(preview.isError || commit.isError) && <p role="alert" className="error">{errorMessage(commit.error ?? preview.error)}</p>}
      </form>}
  </section>;
}

export function CorrectionHistory({ accountId }: { accountId: string }) {
  const query = useInfiniteQuery({
    queryKey: ["corrections", accountId], initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/corrections", {
        params: { path: { account_id: accountId }, query: { cursor: pageParam, limit: 30 } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ? Number(last.nextCursor) : undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.corrections) ?? [];
  return <section className="ledger-section"><h2>冲正记录</h2>
    {query.isPending ? <p role="status">正在读取冲正记录…</p> : query.isError ? <div role="alert">{errorMessage(query.error)}<Button onClick={() => query.refetch()}>重新读取冲正</Button></div>
      : rows.length === 0 ? <p className="secondary">尚无冲正。</p> :
        <div className="table-scroll" role="region" aria-label="冲正记录，可横向滚动" tabIndex={0}><table>
          <thead><tr><th>记录时间</th><th>原因 / 更正内容</th><th className="numeric">现金调整（元）</th><th>原成交记录</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td>{new Date(row.recordedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</td><td>{row.reason}<div className="secondary">{row.replacement ? `更正为 ${row.replacement.quantityShares} 股 × ${row.replacement.price} 元；佣金 ${row.replacement.fees.commission}、印花税 ${row.replacement.fees.stampTax}、过户费 ${row.replacement.fees.transferFee}、其他 ${row.replacement.fees.otherFee} 元` : "整笔作废"}</div></td><td className="numeric">{row.reversalAmount}</td><td>{row.executionId}</td></tr>)}</tbody>
        </table></div>}
    {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>更早冲正</Button>}
  </section>;
}
