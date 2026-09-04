import { openStockDetail } from '../detailStore.js'
import {
  explainOpportunityBlockers,
  opportunityBlockerDetails,
} from '../../shared/opportunityLanguage.js'
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
    label: '待公式确认',
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

function probabilityPct(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? `${(number * 100).toFixed(0)}%`
    : '--'
}

function expectedR(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}R`
}

function eventTime(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '时间待核验'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function entryTypeLabel(value) {
  return {
    PULLBACK: '回踩确认',
    BREAKOUT: '突破确认',
    TAIL_REVERSAL: '尾盘反转',
  }[value] || '等待定价'
}

const PORTFOLIO_VIEW = Object.freeze({
  SECTOR_CAPPED: { label: '同板块集中，先观察', icon: 'compass' },
  CORRELATION_CAPPED: { label: '同主题相关，先观察', icon: 'compass' },
  BUDGET_CAPPED: { label: '风险预算已满，先观察', icon: 'shield' },
})

export default function OpportunityCandidateRow({
  opportunity,
  portfolio,
  added,
  onAdd,
}) {
  const preCatalyst = opportunity.origin === 'PRE_CATALYST'
  const state = preCatalyst
    ? {
        label: '潜伏预判',
        icon: 'radar',
        tone: 'waiting',
      }
    : STATE_VIEW[opportunity.state] || STATE_VIEW.AVOID
  const entryPlan = opportunity.entryPlan
  const exitPlan = opportunity.exitPlan
  const modelScore = opportunity.opportunityScore
  const modelReady = modelScore?.state === 'READY'
    && modelScore?.outOfDistribution !== true
  const blockerExplanation = explainOpportunityBlockers(
    opportunity.blockers,
  )
  const blockerDetails = opportunityBlockerDetails(opportunity.blockers)
  const canAdd = !added
  // 组合层只读提示：仅在候选被同板块集中或预算上限降级时展示，
  // 它不改变个股主状态（主状态始终由 opportunity.state 驱动）。
  const portfolioNote = portfolio
    && PORTFOLIO_VIEW[portfolio.portfolioState]
    ? {
        ...PORTFOLIO_VIEW[portfolio.portfolioState],
        reason: portfolio.portfolioReason || '',
      }
    : null
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
        {preCatalyst && (
          <div className="opportunity-pre-catalyst-signal">
            <Icon name="radar" size={12} />
            <span className="opportunity-pre-catalyst-copy">
              <span>
                启动观察分
                {' '}{Number(opportunity.activationScore || 0).toFixed(1)}
              </span>
              <span>
                尚未定价 {Number(
                  opportunity.underReactionScore || 0,
                ).toFixed(1)}
              </span>
              <span>
                资金试探 {Number(
                  opportunity.flowProbeScore || 0,
                ).toFixed(1)}
              </span>
              <span>
                {opportunity.forecast?.state === 'READY'
                  ? `3日启动率 ${probabilityPct(
                      opportunity.forecast.pActivation3d,
                    )}`
                  : '启动概率校准中'}
              </span>
            </span>
          </div>
        )}
        {modelScore && (
          <div
            className="opportunity-model-signal"
            data-state={modelReady ? 'ready' : 'pending'}
          >
            {modelReady ? (
              <>
                <Icon name="chart" size={12} />
                <span>成交率 {probabilityPct(modelScore.pFill)}</span>
                <span>
                  净盈利率 {probabilityPct(modelScore.pWinGivenFill)}
                </span>
                <span>期望 {expectedR(modelScore.expectedNetR)}</span>
              </>
            ) : (
              <span className="opportunity-model-pending">
                <Icon name="clock" size={12} />
                <span>排序模型样本仍在积累，不影响当前公式结论</span>
              </span>
            )}
          </div>
        )}
        {portfolioNote && (
          <span
            className="opportunity-portfolio-note"
            title={portfolioNote.reason}
          >
            <Icon name={portfolioNote.icon} size={12} />
            {portfolioNote.label}
          </span>
        )}
        <p>
          {opportunity.state === 'READY'
            ? '为什么能买：'
            : opportunity.state === 'AVOID'
              ? '为什么先不买：'
              : '判断依据：'}
          {opportunity.state === 'AVOID'
            ? blockerExplanation
            : ((opportunity.evidence || []).slice(0, 2).join('；')
              || blockerExplanation)}
        </p>
        {preCatalyst && opportunity.event?.sourceUrl && (
          <a
            className="opportunity-event-link"
            href={opportunity.event.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="news" size={12} />
            <span>
              {opportunity.event.eventLabel || '官方事件'}
              {' · '}
              {eventTime(opportunity.event.publishedAt)}
            </span>
          </a>
        )}
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
            <p>尚未形成完整买点，不执行买入。</p>
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
          {blockerDetails.map((item) => (
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
