import { selectionSourcePerformance } from '../../shared/selectionOrigin.js'
import Icon from './Icon'
import {
  reviewTerminology,
} from '../../shared/reviewPresentation.js'

function money(value) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

export default function SelectionPerformance({
  records = [],
  simulation = false,
}) {
  const groups = selectionSourcePerformance(records)
  const terms = reviewTerminology(simulation)
  return (
    <section className="selection-performance" aria-label="选股来源复盘">
      <h2 className="panel-title"><Icon name="chart" size={16} /> 选股来源复盘</h2>
      <p className="muted">{terms.selectionDescription}</p>
      {groups.length ? (
        <div className="selection-performance-list">
          {groups.map((group) => (
            <div className="selection-performance-row" key={group.sourceType}>
              <strong>{group.label}</strong>
              <span>{group.positions}笔持仓 · {group.sales}条卖出</span>
              <span className={group.netPnl >= 0 ? 'red' : 'green'}>
                净收益 {money(group.netPnl)}元
              </span>
              <span>费用 {money(group.fees)}元</span>
            </div>
          ))}
        </div>
      ) : <div className="empty">{terms.emptySelection}</div>}
      {!!groups.length && (
        <p className="muted">
          {groups.reduce((sum, group) => sum + group.positions, 0) < 20
            ? '样本仍少，暂不据此提高仓位。'
            : '样本未按市场环境和持有周期配平，不代表未来收益。'}
          {groups.some((group) => group.sourceType === 'UNRECORDED')
            ? '历史记录中有未关联选股来源的成交。' : ''}
        </p>
      )}
    </section>
  )
}
