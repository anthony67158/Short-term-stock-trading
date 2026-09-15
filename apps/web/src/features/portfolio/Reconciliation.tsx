import { useMutation } from "@tanstack/react-query";
import { api, errorMessage } from "../../lib/api";
import { Button } from "../../components/Controls";

const fields: Record<string, string> = {
  grossAmount: "成交金额", totalFees: "总费用", cashDelta: "现金变动",
  realizedPnl: "已实现盈亏", uncoveredSaleShares: "缺少可卖批次的股数",
  lotExists: "持仓批次", quantity: "剩余股数", basis: "剩余成本",
  instrument: "证券归属", date: "买入日期", sequence: "批次顺序",
  lotConsumption: "成交与批次关联", accountVersion: "账本顺序",
  chronological: "时间顺序", executionCash: "成交结算金额",
  executionVersion: "成交顺序", executionTime: "成交时间",
  nonnegativeCash: "现金非负", cashEntryExists: "结算分录", cashBalance: "现金余额",
};

export function Reconciliation({ accountId, version }: { accountId: string; version: number }) {
  const check = useMutation({
    mutationFn: async () => {
      const result = await api.GET("/api/v1/accounts/{account_id}/reconciliation", {
        params: { path: { account_id: accountId } },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const report = check.data;
  return <section className="ledger-section">
    <div className="section-toolbar"><h2>账本核对</h2><Button onClick={() => check.mutate()} disabled={check.isPending}>{check.isPending ? "正在逐笔复算…" : "核对账本"}</Button></div>
    <p className="source-note">从资金与成交记录独立重算，检查现金、持仓批次和费用。核对通过表示平台内部一致；券商交割单仍需另行比对。</p>
    {check.isError && <p role="alert" className="error">{errorMessage(check.error)}</p>}
    {report && <div role="status">
      {report.accountVersion !== version ? <p className="error">账本已有新记录，请重新核对。</p> : <p className={report.matches ? "save-notice" : "error"}>{report.matches ? "账本核对一致" : `发现 ${report.discrepancyCount} 处差异`}</p>}
      <p className="source-note">已复算 {report.executionCount} 笔成交 · {report.openLotCount} 个未平批次 · 现金 {report.replayCashBalance} 元</p>
      {report.discrepancies.length > 0 && <div className="table-scroll" role="region" aria-label="账本差异，可横向滚动" tabIndex={0}><table><thead><tr><th>记录编号</th><th>核对项</th><th>重算结果</th><th>当前账本</th></tr></thead>
        <tbody>{report.discrepancies.map((issue, i) => <tr key={i}><td>{issue.reference}</td><td>{fields[issue.field] ?? "记录完整性"}</td><td>{issue.expected}</td><td>{issue.actual}</td></tr>)}</tbody></table></div>}
    </div>}
  </section>;
}
