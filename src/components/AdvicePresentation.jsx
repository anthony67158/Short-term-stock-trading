import { useMemo, useState } from 'react'
import { buildAdvicePresentation } from '../../shared/advicePresentation.js'
import { humanizeAdviceTextFields } from '../../shared/userFacingLanguage.js'
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
      <section className="advice-review-cycle off" aria-label="军师事件监控已关闭">
        <div>
          <Icon name="clock" size={12} />
          <span>事件监控已关闭</span>
          <b>仅手动更新</b>
        </div>
        <p>当前主计划保持不变。</p>
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
      aria-label="军师事件监控"
    >
      <div>
        <Icon name="clock" size={12} />
        <span>事件监控</span>
        <b>第 {review.sequence || 1} 次</b>
      </div>
      <p>
        {statusText}
        {review.reason && !statusText.includes(review.reason)
          ? `（${review.reason}）`
          : ''}
        ，下次数据检查 <time dateTime={next.toISOString()}>{nextLabel}</time>。
      </p>
      {review.receipt && (
        <div className="advice-review-receipt">
          <span>本轮核实</span>
          <em>{(review.receipt.checked || []).join('、')}</em>
          {(review.receipt.changes || []).length > 0 && (
            <b>变化：{review.receipt.changes.join('、')}</b>
          )}
        </div>
      )}
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
      aria-label="账户风险检查"
    >
      <div className="aro-title">
        <Icon name="shield" size={12} /> 账户风险检查
        <b>{risk.stopBreached ? '止损已触发' : risk.blocked ? '已阻止新增风险' : '风险提示'}</b>
      </div>
      <div className="aro-reasons">{risk.reasons.join('；')}</div>
    </section>
  )
}

function EvidenceGapNotice({ issues = [] }) {
  if (!Array.isArray(issues) || !issues.length) return null
  const statusLabel = {
    ERROR: '请求失败',
    EMPTY: '空数据',
    SKIPPED: '未运行',
    MISSING: '未采集',
  }
  return (
    <section className="advice-evidence-gap" aria-label="缺失证据说明">
      <div className="aeg-head">
        <span><Icon name="info" size={13} /> 本轮缺失证据</span>
        <b>已阻止新增风险</b>
      </div>
      <div className="aeg-list">
        {issues.map((item) => (
          <div className="aeg-item" key={item.source}>
            <div className="aeg-source">
              <b>{item.label || item.source}</b>
              <span>{statusLabel[item.status] || item.status || '不可用'}</span>
            </div>
            <div className="aeg-detail">
              <span>失败原因</span>
              <p>{item.reason || '本轮未取得有效数据'}</p>
            </div>
            <div className="aeg-detail">
              <span>决策影响</span>
              <p>{item.impact || '该项证据无法参与本轮决策'}</p>
            </div>
            <div className="aeg-detail">
              <span>恢复方式</span>
              <p>{item.recovery || '数据恢复后重新生成'}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function DecisionPlanSummary({ plan }) {
  if (!plan) return null
  const statusLabel = plan.actionabilityLabel || '等待确认'
  const statusTone = plan.actionability === 'READY'
    ? 'ready'
    : plan.actionability === 'MANUAL_PROBE'
      ? 'probe'
    : plan.actionability === 'BLOCKED'
      ? 'blocked'
      : 'watch'
  return (
    <section
      className={`advice-decision-plan ${statusTone}`}
      aria-label="执行校验"
    >
      <div className="adp-head">
        <span><Icon name="shield" size={12} /> 执行校验</span>
        <b>{statusLabel}</b>
      </div>
      <div className="adp-facts">
        {plan.marketRegime && (
          <span>市场 <b>{plan.marketRegime}{plan.marketScore ? ` ${plan.marketScore}分` : ''}</b></span>
        )}
        {plan.evidenceBasis?.label && (
          <span title={plan.evidenceBasis.phase || undefined}>
            数据口径 <b>
              {plan.evidenceBasis.label}
              {plan.evidenceBasis.dataAsOf
                ? ` · 截至 ${plan.evidenceBasis.dataAsOf}`
                : ''}
            </b>
          </span>
        )}
        {plan.opportunity?.sectorName && (
          <span>
            短线依据 <b>
              {plan.opportunity.sectorName}
              {plan.opportunity.stockRole
                ? ` · ${plan.opportunity.stockRole}`
                : ''}
            </b>
          </span>
        )}
        {plan.maxLossAmount && (
          <span>风险预算 <b>¥{Number(plan.maxLossAmount).toLocaleString('zh-CN')}</b></span>
        )}
        {plan.estimatedFees && (
          <span>预计费用 <b>¥{plan.estimatedFees}</b></span>
        )}
      </div>
      <p>{plan.statusText}</p>
    </section>
  )
}

function ExecutionPlanControl({
  plan,
  storedPlan,
  onArmExecutionPlan,
}) {
  if (!plan) return null
  const status = storedPlan?.status || plan.status
  const statusLabel = {
    DRAFT: '尚未加入计划',
    ARMED: '等待条件',
    ALERTED: '价格已触发',
    USER_CONFIRMED: '已确认待记录',
    PARTIALLY_RECORDED: '部分成交',
    COMPLETED: '已完成',
    CANCELED: '已取消',
    EXPIRED: '已过期',
  }[status] || status
  const methodLabel = {
    SINGLE_LIMIT: '建议一次处理',
    SLICED_LIMIT: '建议分批处理',
    TWAP_REFERENCE: '建议分时处理',
    VWAP_REFERENCE: '建议跟随成交量处理',
    ICEBERG_REFERENCE: '建议拆分处理',
  }[plan.methodType] || '手动处理'
  return (
    <div className="advice-execution-queue-action">
      <div>
        <span>{methodLabel}</span>
        <b>{statusLabel}</b>
      </div>
      {plan.canArm && !storedPlan && (
        <button
          type="button"
          className="btn advice-arm-btn"
          onClick={() => onArmExecutionPlan?.()}
        >
          <Icon name="checkSquare" size={13} /> 加入待执行计划
        </button>
      )}
    </div>
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
  executionPlanState = null,
  onArmExecutionPlan,
}) {
  const [expanded, setExpanded] = useState(false)
  const displayAdvice = useMemo(
    () => humanizeAdviceTextFields(advice || {}),
    [advice],
  )
  const displayReview = useMemo(
    () => humanizeAdviceTextFields(knowledgeActionReview || {}),
    [knowledgeActionReview],
  )
  const view = useMemo(
    () => buildAdvicePresentation(displayAdvice),
    [displayAdvice],
  )
  const hasTrigger = Boolean(
    view.trigger.condition
    || view.trigger.confirmation
    || view.trigger.invalidation
    || view.trigger.validationWindow
  )
  const hasDetails = Boolean(
    displayAdvice.reasoning
    || displayAdvice.knowledgeActionPlan
    || displayAdvice.techNote
    || displayAdvice.fundNote
    || displayAdvice.newsNote
    || displayAdvice.macroNote
    || displayAdvice.seatNote
    || displayAdvice.quantNote
    || displayAdvice.theoryNote
    || displayAdvice.bearCase
    || displayAdvice.risk
    || view.model
    || view.decisionPlan
    || view.review
    || view.planSteps.length > 0,
  )

  return (
    <div className="advice-presentation">
      <section
        className={`advice-command-center ${view.verdict.tone}`}
        aria-label="军师执行摘要"
      >
        <div className="advice-command-head">
          <div className="advice-command-verdict">
            <span className={`dv-badge ${view.verdict.tone}`}>
              {view.verdict.action || '等待'}
            </span>
            <div className="advice-command-title">
              {view.verdict.title || '暂无明确结论'}
            </div>
          </div>
          {view.verdict.confidence && (
            <span className="advice-confidence">
              信心 {view.verdict.confidence}
            </span>
          )}
        </div>
        <div className="advice-command-body">
          <div className="advice-command-copy">
            <div className="advice-command-label">
              <Icon name="target" size={13} /> 执行指令
            </div>
            <div className="advice-command-instruction">
              <HL text={
                view.execution.instruction
                || '本次无需操作，等待触发条件出现后再行动。'
              } />
            </div>
            {view.execution.position && (
              <div className="advice-execution-position">
                <span>执行后仓位</span><HL text={view.execution.position} />
              </div>
            )}
          </div>
          {(view.execution.quantity || view.execution.amount || displayAdvice.riskReward) && (
            <div className="advice-execution-metrics">
              {view.execution.quantity && (
                <span>操作 <b>{view.execution.quantity}</b></span>
              )}
              {view.execution.amount && (
                <span>资金 <b>{view.execution.amount}</b></span>
              )}
              {displayAdvice.riskReward && (
                <span>盈亏比 <b>{displayAdvice.riskReward}</b></span>
              )}
            </div>
          )}
        </div>
        <ExecutionPlanControl
          plan={view.executionPlan}
          storedPlan={executionPlanState}
          onArmExecutionPlan={onArmExecutionPlan}
        />
      </section>

      <RiskOverlay risk={displayAdvice.riskOverlay} />
      <EvidenceGapNotice
        issues={view.decisionPlan?.evidenceIssues}
      />

      {(view.levels.length > 0 || hasTrigger) && (
        <div className={'advice-tactical-grid' + (view.observationOnly ? ' observation-only' : '')}>
          {view.levels.length > 0 && (
            <section
              className="advice-levels"
              aria-label={view.observationOnly ? '观察价位' : '关键价位'}
            >
              <div className="advice-section-title">
                {view.observationOnly ? '观察价位' : '关键价位'}
              </div>
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
            <section
              className="advice-trigger"
              aria-label={view.trigger.title || '触发与失效'}
            >
              <div className="advice-section-title">
                <Icon name="shield" size={13} /> {view.trigger.title || '触发与失效'}
              </div>
              <div className="advice-trigger-rows">
                {view.trigger.condition && (
                  <div><span>{view.trigger.conditionLabel || '触发'}</span><HL text={view.trigger.condition} /></div>
                )}
                {view.trigger.confirmation && (
                  <div><span>{view.trigger.confirmationLabel || '确认'}</span><HL text={view.trigger.confirmation} /></div>
                )}
                {view.trigger.invalidation && (
                  <div className="invalid"><span>{view.trigger.invalidationLabel || '失效'}</span><HL text={view.trigger.invalidation} /></div>
                )}
                {view.trigger.validationWindow && (
                  <div><span>{view.trigger.validationLabel || '验证'}</span>{view.trigger.validationWindow}</div>
                )}
              </div>
            </section>
          )}
        </div>
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
      {displayAdvice.serverAdjust && (
        <div className="advice-adjust">
          <Icon name="shield" size={12} /> 已按规则校正：{displayAdvice.serverAdjust}
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
              <Icon name="layers" size={12} /> 完整依据与复核
            </span>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
          </button>
          {expanded && (
            <div className="advice-deep-content">
              <Continuity continuity={displayAdvice.continuity} />
              <ReviewCycle review={view.review} enabled={reviewEnabled} />
              <DecisionContext context={displayAdvice.decisionContext} />
              <DecisionPlanSummary plan={view.decisionPlan} />
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
                    <span>
                      <Icon name="activity" size={13} /> {view.model.label}
                    </span>
                    {view.model.experimental && <b>实验</b>}
                  </div>
                  <div className="amc-meta">
                    {view.model.horizon && (
                      <span>窗口 {view.model.horizon}</span>
                    )}
                    {view.model.asOf && (
                      <span>
                        {view.model.asOfLabel || '信号'} {view.model.asOf}
                      </span>
                    )}
                  </div>
                  {view.model.nextTradeDayText && (
                    <div className="amc-next">
                      {view.model.nextTradeDayText}
                    </div>
                  )}
                  {view.model.reliabilityText && (
                    <div className="amc-reliability">
                      {view.model.reliabilityText}
                    </div>
                  )}
                  {view.model.fallback && (
                    <div className="amc-fallback">
                      已回退 V2.0：{view.model.fallback.reason}
                    </div>
                  )}
                </section>
              )}
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
              <TheoryReferences references={displayAdvice.theoryRefs} />
              <SearchReference reference={displayAdvice.searchReference} />
              <AdviceDetails advice={displayAdvice} review={displayReview} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
