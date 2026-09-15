import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Input } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

export function CustodyTransfers({ account }: { account: components["schemas"]["AccountView"] }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const command = useRef({ body: "", key: "" });
  const history = useInfiniteQuery({
    queryKey: ["transfers", account.id], initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/custody-transfers", {
        params: { path: { account_id: account.id }, query: { cursor: pageParam, limit: 30 } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ? Number(last.nextCursor) : undefined,
  });
  const save = useMutation({
    mutationFn: async (body: components["schemas"]["TransferInput"]) => {
      const serialized = JSON.stringify(body);
      if (serialized !== command.current.body) command.current = { body: serialized, key: crypto.randomUUID() };
      const result = await api.POST("/api/v1/accounts/{account_id}/custody-transfers", {
        params: { path: { account_id: account.id }, header: { "Idempotency-Key": command.current.key } }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      setEditing(false);
      for (const key of ["balance", "positions", "transfers", "plans"])
        await cache.invalidateQueries({ queryKey: [key, account.id] });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key)).trim();
    save.mutate({
      instrumentId: `${value("exchange")}.${value("code")}`,
      quantityShares: Number(value("quantity")), costBasis: value("basis"),
      acquiredDate: value("acquired"), effectiveAt: new Date(value("time")).toISOString(),
      sourceKey: value("reference"), source: value("source"), expectedVersion: account.version,
    });
  }
  const rows = history.data?.pages.flatMap((page) => page.transfers) ?? [];
  return <section className="ledger-section">
    <div className="section-toolbar"><h2>转托管记录</h2><Button disabled={editing} onClick={() => { setEditing(true); save.reset(); }}>录入股份转入</Button></div>
    <p className="source-note">按原取得批次录入已到账股份与剩余总成本。转入不扣现金，不记为买入；原取得日用于核对可卖股数。当前仅支持转入。</p>
    {editing && <form className="inline-form" onSubmit={submit}>
      <label className="field"><span>转入证券市场</span><select name="exchange" defaultValue="SZ"><option value="SZ">深圳</option><option value="SH">上海</option><option value="BJ">北京</option></select></label>
      <Input id="transfer-code" label="转入证券代码" name="code" pattern="\d{6}" required autoFocus />
      <Input id="transfer-quantity" label="转入股数" name="quantity" type="number" min={1} max={1_000_000_000} step={1} required />
      <Input id="transfer-basis" label="转入剩余总成本（元）" name="basis" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required />
      <Input id="transfer-acquired" label="原股份取得日（上海日期）" name="acquired" type="date" required />
      <Input id="transfer-time" label="转入到账时间（本设备时区）" name="time" type="datetime-local" step={1} required />
      <Input id="transfer-reference" label="转托管凭据编号" name="reference" maxLength={128} required />
      <Input id="transfer-source" label="转托管凭据说明" name="source" maxLength={300} required />
      <div className="form-actions"><Button variant="primary" type="submit" disabled={save.isPending}>{save.isPending ? "正在入账…" : "保存股份转入"}</Button><Button type="button" onClick={() => setEditing(false)} disabled={save.isPending}>取消</Button></div>
      {save.isError && <p className="error" role="alert">{errorMessage(save.error)}</p>}
    </form>}
    {save.isSuccess && <p className="save-notice" role="status">股份转入已保存，现金未变动。</p>}
    {history.isPending ? <p role="status">正在读取转托管记录…</p> : history.isError ? <p role="alert">{errorMessage(history.error)}<Button onClick={() => history.refetch()}>重新读取转托管</Button></p>
      : rows.length === 0 ? <p className="secondary">尚无转托管记录。</p> :
        <div className="table-scroll" role="region" aria-label="转托管明细，可横向滚动" tabIndex={0}><table><thead><tr><th>证券 / 凭据</th><th>到账时间 / 原取得日</th><th className="numeric">转入股数</th><th className="numeric">转入总成本（元）</th><th>来源</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><td>{row.instrumentId}<div className="secondary">{row.sourceKey}</div></td><td>{new Date(row.effectiveAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}<div className="secondary">{row.acquiredDate}</div></td><td className="numeric">{row.quantityShares}</td><td className="numeric">{row.costBasis}</td><td>{row.source}</td></tr>)}</tbody></table></div>}
    {history.hasNextPage && <Button disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>更早转托管</Button>}
  </section>;
}
