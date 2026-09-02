import { openStockDetail } from '../detailStore.js'
import Icon from './Icon'
import StockName from './StockName'

const STATE_VIEW = Object.freeze({
  READY: {
    label: '可以买入',
    icon: 'target',
    tone: 'ready',
  },
  WAIT_TRIGGER: {
    label: '到价再买',
    icon: 'clock',
    tone: 'waiting',
  },
  SECTOR_WATCH: {
    label: '方向可看',
    icon: 'compass',
    tone: 'sector',
  },
  AVOID: {
    label: '本次不买',
    icon: 'shield',
    tone: 'avoid',
  },
})

function price(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? number.toFixed(2)
    : '--'
}

function pct(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`
}

function entryTypeLabel(value) {
  return {
    PULLBACK: '回踩确认',
    BREAKOUT: '突破确认',
    TAIL_REVERSAL: '尾盘反转',
  }[value] || '等待定价'
}

export default function OpportunityCandidateRow({
  opportunity,
  added,
  onAdd,
}) {
  const state = STATE_VIEW[opportunity.state] || STATE_VIEW.AVOID
  const entryPlan = opportunity.entryPlan
  const exitPlan = opportunity.exitPlan
  const canAdd = !added
  return (
    <article
      className="opportunity-row"
      data-state={state.tone}
    >
      <div className="opportunity-identity">
        <span className="opportunity-state">
          <Icon name={state.icon} size={14} />
          {state.label}
        </span>
        <StockName
          code={opportunity.code}
          name={opportunity.name}
          industry={opportunity.sector?.name}
          showTags={false}
        />
        <span className="opportunity-quote">
          {price(opportunity.quote?.price)}
          <small>{pct(opportunity.quote?.pct)}</small>
        </span>
      </div>

      <div className="opportunity-context">
        <strong>
          {opportunity.sector?.name || '暂未匹配主线'}
        </strong>
        <span>
          {(opportunity.sourceSignals || []).join(' · ')}
        </span>
        <p>
          {opportunity.state === 'READY' ? '为什么能买：' : '判断依据：'}
          {(opportunity.evidence || []).slice(0, 2).join('；')
            || opportunity.blockers?.[0]
            || '等待更多有效证据'}
        </p>
      </div>

      <div className="opportunity-plan-grid">
        <section className="opportunity-entry">
          <div className="opportunity-plan-title">
            <Icon name="target" size={14} />
            <span>买入条件</span>
            <b>{entryTypeLabel(entryPlan?.type)}</b>
          </div>
          {entryPlan ? (
            <>
              <strong className="opportunity-price">
                {price(entryPlan.price)}
              </strong>
              <p>{entryPlan.trigger}</p>
              <small>
                {entryPlan.window} · 最大仓位
                {' '}{entryPlan.maxPositionPct}%
              </small>
            </>
          ) : (
            <p>方向可看，尚无买点；先进入个股详情核验价格。</p>
          )}
        </section>

        <section className="opportunity-exit">
          <div className="opportunity-plan-title">
            <Icon name="shield" size={14} />
            <span>卖出计划</span>
          </div>
          {exitPlan ? (
            <>
              <div className="opportunity-exit-prices">
                <span>止损 <b>{price(exitPlan.hardStopPrice)}</b></span>
                <span>
                  止盈 <b>{price(exitPlan.takeProfitPrice)}</b>
                </span>
              </div>
              <p>{exitPlan.rule}</p>
              <small>
                时间退出 {exitPlan.timeStopDate || '待确认'}
                {' · '}{exitPlan.t1Constraint}
              </small>
            </>
          ) : (
            <p>尚未形成完整价格合同，不执行买入。</p>
          )}
        </section>
      </div>

      <details className="opportunity-evidence">
        <summary>查看依据和限制</summary>
        <div>
          {(opportunity.evidence || []).map((item) => (
            <span key={`e-${item}`}>{item}</span>
          ))}
          {(opportunity.blockers || []).map((item) => (
            <span className="blocker" key={`b-${item}`}>{item}</span>
          ))}
        </div>
      </details>

      <div className="opportunity-actions">
        <button
          type="button"
          className="chip-btn"
          onClick={() => openStockDetail(
            opportunity.code,
            opportunity.name,
          )}
        >
          <Icon name="chart" size={14} />
          查看详情
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canAdd}
          onClick={() => onAdd(opportunity)}
        >
          <Icon name={added ? 'check' : 'plus'} size={14} />
          {added
            ? '已在自选'
            : '加入自选'}
        </button>
      </div>
    </article>
  )
}
