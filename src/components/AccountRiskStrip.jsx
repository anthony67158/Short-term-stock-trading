import { buildAccountRiskContext } from '../../shared/accountRiskBudget.js'
import {
  formatAccountRiskBlocker,
} from '../../shared/accountRiskPresentation.js'
import Icon from './Icon'

function money(value) {
  return Math.floor(value).toLocaleString('zh-CN')
}

export default function AccountRiskStrip({ book, quotes, risk: suppliedRisk }) {
  const risk = suppliedRisk || buildAccountRiskContext(book, quotes)
  return (
    <section className="account-risk-strip" aria-label="账户风险预算">
      <div className="account-risk-metrics">
        <strong><Icon name="shield" size={15} /> 本账户风险</strong>
        <span>新增资金预算 <b>{money(risk.availableCash)}元</b></span>
        <span>待买预留 <b>{money(risk.breaker.reservedBuyCash)}元</b></span>
        <span>持仓止损参考风险 <b>{money(risk.breaker.holdingRiskAmount)}元</b></span>
        <span>剩余风险预算 <b>{money(risk.availableRisk)}元</b></span>
      </div>
      {risk.breaker.blockers.length > 0 ? (
        <p role="status">{risk.breaker.blockers.map((item) =>
          formatAccountRiskBlocker(item)
        ).join('；')}</p>
      ) : !risk.complete ? <p role="status">账户或持仓报价尚未完整，暂不提供新增仓位预算。</p> : null}
    </section>
  )
}
