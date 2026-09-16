import { useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../../../../packages/api-client/schema";
import { Button, Input } from "../../components/Controls";
import { api, errorMessage } from "../../lib/api";

type Account = components["schemas"]["AccountView"];
type ShareInput = components["schemas"]["CorporateShareInput"];

export function CorporateShares({ account }: { account: Account }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(false);
  const command = useRef({ body: "", key: "" });
  const history = useInfiniteQuery({
    queryKey: ["corporate-shares", account.id],
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await api.GET(
        "/api/v1/accounts/{account_id}/corporate-share-events",
        {
          params: {
            path: { account_id: account.id },
            query: { cursor: pageParam, limit: 30 },
          },
          signal,
        },
      );
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    getNextPageParam: (last) =>
      last.nextCursor ? Number(last.nextCursor) : undefined,
  });
  const save = useMutation({
    mutationFn: async (body: ShareInput) => {
      const serialized = JSON.stringify(body);
      if (serialized !== command.current.body) {
        command.current = {
          body: serialized,
          key: crypto.randomUUID(),
        };
      }
      const result = await api.POST(
        "/api/v1/accounts/{account_id}/corporate-share-events",
        {
          params: {
            path: { account_id: account.id },
            header: { "Idempotency-Key": command.current.key },
          },
          body,
        },
      );
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      setEditing(false);
      for (const key of [
        "balance",
        "positions",
        "corporate-shares",
        "plans",
      ]) {
        await cache.invalidateQueries({ queryKey: [key, account.id] });
      }
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key)).trim();
    save.mutate({
      kind: value("kind") as ShareInput["kind"],
      instrumentId: `${value("exchange")}.${value("code")}`,
      quantityShares: Number(value("quantity")),
      effectiveAt: new Date(value("time")).toISOString(),
      sourceKey: value("reference"),
      source: value("source"),
      expectedVersion: account.version,
    });
  }
  const rows = history.data?.pages.flatMap((page) => page.events) ?? [];
  return (
    <section className="ledger-section">
      <div className="section-toolbar">
        <h2>送转股份</h2>
        <Button
          disabled={editing}
          onClick={() => {
            setEditing(true);
            save.reset();
          }}
        >
          录入到账股份
        </Button>
      </div>
      <p className="source-note">
        只录入券商已经到账的送股或拆股。新增股份按现有批次比例分配，总成本保持不变，现金不变。
      </p>
      {editing && (
        <form className="inline-form" onSubmit={submit}>
          <label className="field">
            <span>公司行动类型</span>
            <select name="kind" defaultValue="STOCK_DIVIDEND">
              <option value="STOCK_DIVIDEND">送股</option>
              <option value="SPLIT">拆股</option>
            </select>
          </label>
          <label className="field">
            <span>证券市场</span>
            <select name="exchange" defaultValue="SZ">
              <option value="SZ">深圳</option>
              <option value="SH">上海</option>
              <option value="BJ">北京</option>
            </select>
          </label>
          <Input
            id="corporate-share-code"
            label="证券代码"
            name="code"
            pattern="\d{6}"
            required
          />
          <Input
            id="corporate-share-quantity"
            label="实际到账股数"
            name="quantity"
            type="number"
            min={1}
            max={1_000_000_000}
            step={1}
            required
          />
          <Input
            id="corporate-share-time"
            label="到账时间（本设备时区）"
            name="time"
            type="datetime-local"
            step={1}
            required
          />
          <Input
            id="corporate-share-reference"
            label="券商凭据编号"
            name="reference"
            maxLength={128}
            required
          />
          <Input
            id="corporate-share-source"
            label="凭据说明"
            name="source"
            maxLength={300}
            required
          />
          <div className="form-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={save.isPending}
            >
              {save.isPending ? "正在入账" : "保存到账股份"}
            </Button>
            <Button type="button" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
          {save.isError && (
            <p className="error" role="alert">
              {errorMessage(save.error)}
            </p>
          )}
        </form>
      )}
      {save.isSuccess && (
        <p className="save-notice" role="status">
          到账股份已保存，总成本与现金保持不变。
        </p>
      )}
      {history.isPending ? (
        <p role="status">正在读取送转股份记录…</p>
      ) : history.isError ? (
        <p className="error" role="alert">
          {errorMessage(history.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="secondary">尚无送转股份记录。</p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="送转股份记录，可横向滚动"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>证券 / 凭据</th>
                <th>类型</th>
                <th>到账时间</th>
                <th className="numeric">股数</th>
                <th>批次分配</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.instrumentId}
                    <div className="secondary">{row.sourceKey}</div>
                  </td>
                  <td>{row.kind === "STOCK_DIVIDEND" ? "送股" : "拆股"}</td>
                  <td>
                    {new Date(row.effectiveAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false,
                    })}
                  </td>
                  <td className="numeric">{row.quantityShares}</td>
                  <td>{row.allocations.length} 个现有批次</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
