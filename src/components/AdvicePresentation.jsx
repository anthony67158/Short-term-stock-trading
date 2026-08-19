import { useMemo, useState } from 'react'
import { buildAdvicePresentation } from '../../shared/advicePresentation.js'
import AdviceDetails from './AdviceDetails'
import Icon from './Icon'
import { HL } from './RichText'
import SearchReference from './SearchReference'

const CONTINUITY_LABELS = {
  initial: '已建立主计划',
  maintain: '主计划延续',
  adjust: '方向不变 · 执行区间已更新',
  reverse: '客观信号确认 · 趋势版本已切换',
  blocked: '方向冲突已拦截 · 继续以上一版为准',
}

function Continuity({ continuity }) {
  if (!continuity) return null
  const blocked = continuity.changeType === 'blocked'
  return (
    <div className={'advice-continuity ' + (blocked ? 'blocked' : continuity.changeType || '')}>
      <div className="ac-head">
        <span>
          <Icon name={blocked ? 'shield' : 'history'} size={12} />
          {CONTINUITY_LABELS[continuity.changeType] || '主计划已更新'}
        </span>
        <b>趋势 V{continuity.thesisVersion || 1} · 修订 {continuity.revision || 1}</b>
      </div>
      {continuity.changeReason && <div className="ac-reason">{continuity.changeReason}</div>}
      {blocked && continuity.proposedAction && (
        <div className="ac-proposed">
          本次候选意见“{continuity.proposedAction}”未取得反转资格，未覆盖当前计划。
        </div>
      )}
    </div>
  )
}

function ReviewCycle({ review, enabled = true }) {
  if (!enabled) {
    return (
      <section className="advice-review-cycle off" aria-label="军师持续复核已关闭">
        <div>
          <Icon name="clock" size={12} />
          <span>持续复核已关闭</span>
          <b>仅手动更新</b>
        </div>
        <p>当前主计划保持不变，不再自动生成后续建议或军师派生预警。</p>
      </section>
    )
  }
  if (!review?.nextReviewAt) return null
  const next = new Date(review.nextReviewAt)
  const nextLabel = next.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const changed = review.changeType === 'reverse'
    ? '本轮已改变方向'
    : review.changeType === 'adjust'
      ? '本轮已调整执行区间'
      : review.changeType === 'initial'
        ? '本轮已建立主计划'
        : review.changeType === 'blocked'
          ? '本轮候选反转已被纪律拦截'
          : '本轮维持原计划'
  const statusText = review.status === 'insufficient'
    ? '关键证据不足，已保留上一版完整计划'
    : review.status === 'unchanged'
      ? '关键证据无实质变化，未重复调用模型'
      : changed
  return (
    <section
      className={`advice-review-cycle ${review.status || ''}`}
      aria-label="军师持续复核"
    >
      <div>
        <Icon name="clock" size={12} />
        <span>军师持续复核</span>
        <b>第 {review.sequence || 1} 次</b>
      </div>
      <p>
        {statusText}
        {review.reason && !statusText.includes(review.reason)
          ? `（${review.reason}）`
          : ''}
        ，下次将于 <time dateTime={next.toISOString()}>{nextLabel}</time> 自动检查。
      </p>
    </section>
  )
}

function DecisionContext({ context }) {
  if (!context) return null
  const topIndustry = Array.isArray(context.industryWeights)
    ? context.industryWeights[0]
    : null
  const values = [
    ['持仓', context.holdQty != null ? `${context.holdQty}手` : null],
    ['成本', context.holdCost != null ? `${context.holdCost}元` : null],
    ['今日可卖', context.sellableTodayQty != null ? `${context.sellableTodayQty}手` : null],
    ['可用资金', context.cash != null ? `${Math.round(context.cash).toLocaleString('zh-CN')}元` : null],
    ['现金储备', context.cashReservePct != null ? `${context.cashReservePct}%` : null],
    ['总仓位', context.position != null ? `${context.position}%` : null],
    ['单票占比', context.stockWeight != null ? `${context.stockWeight}%` : null],
    ['行业最高', topIndustry ? `${topIndustry.industry} ${topIndustry.weight}%` : null],
  ].filter(([, value]) => value != null)
  if (!values.length) return null
  return (
    <section className="advice-decision-context" aria-label="本次决策账户快照">
      <div className="adc-title"><Icon name="wallet" size={12} /> 本次决策账户快照</div>
      <div className="adc-values">
        {values.map(([label, value]) => (
          <span key={label}>{label} <b>{value}</b></span>
        ))}
      </div>
    </section>
  )
}

function RiskOverlay({ risk }) {
  if (!risk || !Array.isArray(risk.reasons) || !risk.reasons.length) return null
  const defensive = risk.blocked || risk.stopBreached || risk.weakMarketDefense
  return (
    <section
      className={'advice-risk-overlay ' + (defensive ? 'defensive' : risk.level || '')}
      aria-label="账户风险闸门"
    >
      <div className="aro-title">
        <Icon name="shield" size={12} /> 账户风险闸门
        <b>{risk.stopBreached ? '止损已触发' : risk.blocked ? '已阻止新增风险' : '风险提示'}</b>
      </div>
      <div className="aro-reasons">{risk.reasons.join('；')}</div>
    </section>
  )
}

function TheoryReferences({ references }) {
  const items = Array.isArray(references)
    ? references.filter((item) => item?.book && item?.topic).slice(0, 6)
    : []
  if (!items.length) return null
  return (
    <section className="theory-refs" aria-label="本次参考理论">
      <span className="theory-refs-label">
        <Icon name="book" size={11} /> 参考理论
      </span>
      {items.map((item) => (
        <span
          className="theory-chip"
          key={`${item.book}:${item.topic}`}
          title={`${item.book} · ${item.topic}`}
        >
          {item.book}·{item.topic}
        </span>
      ))}
    </section>
  )
}

export default function AdvicePresentation({
  advice,
  knowledgeActionReview,
  reviewEnabled = true,
}) {
  const [expanded, setExpanded] = useState(false)
  const view = useMemo(() => buildAdvicePresentation(advice), [advice])
  const hasTrigger = Object.values(view.trigger).some(Boolean)
  const hasDetails = Boolean(
    advice.reasoning
    || advice.knowledgeActionPlan
    || advice.techNote
    || advice.fundNote
    || advice.newsNote
    || advice.macroNote
    || advice.seatNote
    || advice.quantNote
    || advice.theoryNote
    || advice.bearCase
    || advice.risk
    || view.planSteps.length > 0,
  )

  return (
    <div className="advice-presentation">
      <div className={'decide-verdict ' + view.verdict.tone}>
        <div className="dv-head">
          {view.verdict.action && (
            <span className={'dv-badge ' + view.verdict.tone}>{view.verdict.action}</span>
          )}
          <div className="dv-action">{view.verdict.title || '暂无明确结论'}</div>
          {view.verdict.confidence && (
            <span className="advice-confidence">信心 {view.verdict.confidence}</span>
          )}
        </div>
      </div>

      <Continuity continuity={advice.continuity} />
      <ReviewCycle review={view.review} enabled={reviewEnabled} />
      <DecisionContext context={advice.decisionContext} />
      <RiskOverlay risk={advice.riskOverlay} />

      {view.model && (
        <section
          className={
            'advice-model-context'
            + (view.model.experimental ? ' experimental' : '')
            + (view.model.fallback ? ' fallback' : '')
          }
          aria-label="本次量化模型"
        >
          <div className="amc-head">
            <span><Icon name="activity" size={13} /> {view.model.label}</span>
            {view.model.experimental && <b>实验</b>}
          </div>
          <div className="amc-meta">
            {view.model.horizon && <span>窗口 {view.model.horizon}</span>}
            {view.model.asOf && (
              <span>{view.model.asOfLabel || '信号'} {view.model.asOf}</span>
            )}
          </div>
          {view.model.reliabilityText && (
            <div className="amc-reliability">{view.model.reliabilityText}</div>
          )}
          {view.model.fallback && (
            <div className="amc-fallback">
              已回退 V2.0：{view.model.fallback.reason}
            </div>
          )}
        </section>
      )}

      <section className="advice-execution" aria-label="现在怎么做">
        <div className="advice-section-title">
          <Icon name="target" size={13} /> 执行指令
        </div>
        <div className="advice-execution-main">
          <HL text={view.execution.instruction || '本次无需操作，等待触发条件出现后再行动。'} />
        </div>
        {(view.execution.quantity || view.execution.amount || advice.riskReward) && (
          <div className="advice-execution-metrics">
            {view.execution.quantity && <span>操作 <b>{view.execution.quantity}</b></span>}
            {view.execution.amount && <span>资金 <b>{view.execution.amount}</b></span>}
            {advice.riskReward && <span>盈亏比 <b>{advice.riskReward}</b></span>}
          </div>
        )}
        {view.execution.position && (
          <div className="advice-execution-position">
            <span>仓位</span><HL text={view.execution.position} />
          </div>
        )}
      </section>

      {view.levels.length > 0 && (
        <section className="advice-levels" aria-label="关键价位">
          <div className="advice-section-title">关键价位</div>
          <div className="advice-prices compact">
            {view.levels.map((level) => (
              <div className={'ap-cell ' + level.key} key={level.key}>
                <span className="ap-k">{level.label}</span>
                <span className={'ap-v ' + level.tone}>{level.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasTrigger && (
        <section className="advice-trigger" aria-label="触发与失效">
          <div className="advice-section-title"><Icon name="shield" size={13} /> 触发与失效</div>
          <div className="advice-trigger-rows">
            {view.trigger.condition && (
              <div><span>触发</span><HL text={view.trigger.condition} /></div>
            )}
            {view.trigger.confirmation && (
              <div><span>确认</span><HL text={view.trigger.confirmation} /></div>
            )}
            {view.trigger.invalidation && (
              <div className="invalid"><span>失效</span><HL text={view.trigger.invalidation} /></div>
            )}
            {view.trigger.validationWindow && (
              <div><span>验证</span>{view.trigger.validationWindow}</div>
            )}
          </div>
        </section>
      )}

      {view.evidence.length > 0 && (
        <section className="advice-core-evidence" aria-label="核心依据">
          <div className="advice-section-title">三条核心依据</div>
          {view.evidence.map((item) => (
            <div className="advice-evidence-row" key={item.key}>
              <span className={'ab-k ' + item.key}>{item.label}</span>
              <span><HL text={item.text} /></span>
            </div>
          ))}
        </section>
      )}
      <TheoryReferences references={advice.theoryRefs} />
      <SearchReference reference={advice.searchReference} />

      {advice.serverAdjust && (
        <div className="advice-adjust">
          <Icon name="shield" size={12} /> 已按合规校正：{advice.serverAdjust}
        </div>
      )}

      {hasDetails && (
        <div className="advice-deep">
          <button
            type="button"
            className="advice-deep-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span className="adt-label">
              <Icon name="layers" size={12} /> 完整分析 · 推理、契约与复盘
            </span>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
          </button>
          {expanded && (
            <>
              {view.planSteps.length > 0 && (
                <section className="advice-plan-paths" aria-label="完整执行路径">
                  <div className="advice-section-title">完整执行路径</div>
                  {view.planSteps.map((step) => (
                    <div className="advice-plan-step" key={step.key}>
                      <span>{step.label}</span>
                      <HL text={step.text} />
                    </div>
                  ))}
                </section>
              )}
              <AdviceDetails advice={advice} review={knowledgeActionReview} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
