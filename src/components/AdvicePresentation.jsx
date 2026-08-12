import { useMemo, useState } from 'react'
import { buildAdvicePresentation } from '../../shared/advicePresentation.js'
import AdviceDetails from './AdviceDetails'
import Icon from './Icon'
import { HL } from './RichText'

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

export default function AdvicePresentation({ advice, knowledgeActionReview }) {
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
    || advice.risk,
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

      <section className="advice-execution" aria-label="现在怎么做">
        <div className="advice-section-title">
          <Icon name="target" size={13} /> 现在怎么做
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
        {(advice.nextOpenPlan || advice.futurePlan) && (
          <div className="advice-horizon compact">
            {advice.nextOpenPlan && (
              <div className="ah-row now">
                <span className="ah-k">下个开盘</span>
                <span className="ah-v"><HL text={advice.nextOpenPlan} /></span>
              </div>
            )}
            {advice.futurePlan && (
              <div className="ah-row future">
                <span className="ah-k">后续路径</span>
                <span className="ah-v"><HL text={advice.futurePlan} /></span>
              </div>
            )}
          </div>
        )}
      </section>

      {view.levels.length > 0 && (
        <section className="advice-levels" aria-label="关键价位">
          <div className="advice-section-title">关键价位</div>
          <div className="advice-prices compact">
            {view.levels.map((level) => (
              <div className="ap-cell" key={level.key}>
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
            <AdviceDetails advice={advice} review={knowledgeActionReview} />
          )}
        </div>
      )}
    </div>
  )
}
