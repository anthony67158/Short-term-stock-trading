import { useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import type { components } from "../../../../../packages/api-client/schema";
import { Button } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Account = components["schemas"]["AccountView"];
const labels = { NEW: "待入账", DUPLICATE: "重复，跳过", ERROR: "需修正" };

export function ExecutionImport({ account }: { account: Account }) {
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const importId = params.get("import") ?? "";
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const command = useRef({ serialized: "", key: "" });
  const preview = useQuery({
    queryKey: ["execution-import", account.id, importId], enabled: !!importId,
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/accounts/{account_id}/execution-imports/{import_id}", {
        params: { path: { account_id: account.id, import_id: importId } }, signal,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("请先选择CSV文件");
      const body = { csvText: file.text, expectedVersion: account.version };
      const serialized = JSON.stringify(body);
      if (command.current.serialized !== serialized) command.current = { serialized, key: crypto.randomUUID() };
      const result = await api.POST("/api/v1/accounts/{account_id}/execution-imports", {
        params: { path: { account_id: account.id }, header: { "Idempotency-Key": command.current.key } }, body,
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: (data) => {
      cache.setQueryData(["execution-import", account.id, data.id], data);
      setParams((previous) => { previous.set("import", data.id); previous.set("account", account.id); return previous; });
    },
  });
  const commit = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("请先预览文件");
      const result = await api.POST("/api/v1/accounts/{account_id}/execution-imports/{import_id}/confirmations", {
        params: { path: { account_id: account.id, import_id: importId } },
        body: { expectedVersion: preview.data.accountVersion },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async (data) => {
      cache.setQueryData(["execution-import", account.id, data.id], data);
      for (const key of ["balance", "cash", "positions", "executions"])
        await cache.invalidateQueries({ queryKey: [key, account.id] });
    },
  });
  async function choose(event: ChangeEvent<HTMLInputElement>) {
    setFile(null); setError(""); create.reset(); commit.reset();
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (selected.size > 250_000) { setError("文件超过250KB，请拆分后导入"); return; }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await selected.arrayBuffer());
      setFile({ name: selected.name, text });
    } catch { setError("无法读取UTF-8文件，请重新导出"); }
  }
  const result = preview.data;
  const expired = result ? new Date(result.expiresAt).getTime() <= Date.now() : false;
  const stale = result ? result.accountVersion !== account.version : false;
  return <section className="ledger-section"><h2>交割单导入</h2>
    <p className="secondary">使用统一CSV模板，最多500笔、250KB，按成交时间先后排列。费用必须为实际值，时间须包含时区。预览不记账，有错误时整批停止。</p>
    <p><a href="/execution-import-template.csv" download>下载交割单CSV模板</a> · 模板仅包含列名，请按券商凭据填写。</p>
    <label className="field"><span>交割单文件（UTF-8 CSV）</span><input type="file" accept=".csv,text/csv" onChange={choose} disabled={create.isPending || commit.isPending} /></label>
    {file && <p>{file.name}</p>}
    <Button onClick={() => create.mutate()} disabled={!file || create.isPending || commit.isPending}>{create.isPending ? "正在逐笔校验…" : "预览交割单"}</Button>
    {(error || create.isError || commit.isError) && <p role="alert" className="error">{error || errorMessage(commit.error ?? create.error)}</p>}
    {importId && (preview.isPending ? <p role="status">正在读取导入预览…</p> : preview.isError ? <div role="alert">{errorMessage(preview.error)}<Button onClick={() => preview.refetch()}>重读导入预览</Button></div> : result && <>
      <p role="status">{result.status === "COMMITTED" ? "交割单已入账，重复记录已跳过。" : result.status === "REJECTED" ? "文件存在错误，请逐项修正后重新上传。" : expired ? "预览已过期，请重新预览。" : stale ? "账户已有变化，请重新预览。" : "逐笔核对通过，确认后才会记账。"}</p>
      <div className="table-scroll" role="region" aria-label="交割单预览，可横向滚动" tabIndex={0}><table>
        <thead><tr><th>数据行</th><th>交割编号</th><th>校验状态</th><th>说明</th></tr></thead>
        <tbody>{result.rows.map((row) => <tr key={row.row}><td>{row.row}</td><td>{row.sourceKey || "缺失"}</td><td>{result.status === "COMMITTED" && row.status === "NEW" ? "已入账" : labels[row.status]}</td><td>{result.status === "COMMITTED" ? row.status === "NEW" ? "已保存成交事实" : "重复成交已跳过" : row.message}</td></tr>)}</tbody>
      </table></div>
      {result.status === "READY" && <Button variant="primary" disabled={expired || stale || commit.isPending || create.isPending} onClick={() => commit.mutate()}>{commit.isPending ? "正在入账…" : "确认导入全部有效成交"}</Button>}
    </>)}
  </section>;
}
