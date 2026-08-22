import Icon from './Icon'
import Reasoning from './Reasoning'
import { HL } from './RichText'

const DIMENSION_LABELS = {
  executability: '可执行',
  logicConsistency: '逻辑一致',
  falsifiability: '可证伪',
  disciplineCompliance: '纪律',
  reviewability: '可复盘',
}

function KnowledgeAction({ advice }) {
  const plan = advice.knowledgeActionPlan
  if (!plan) return null
  const score = advice.knowledgeActionScore || {}
  const dimensions = score.dimensions || {}
  return (
    <section className="knowledge-action-card" aria-label="知行合一交易契约">
      <div className="ka-head">
        <span><Icon name="checkSquare" size={13} /> 知行合一交易契约</span>
        <strong>{score.total ?? '—'}分 · {score.grade || '待评估'}</strong>
      </div>
      <div className="ka-dimensions">
        {Object.entries(DIMENSION_LABELS).map(([key, label]) => dimensions[key] && (
          <span key={key}>{label} <b>{dimensions[key].score}/{dimensions[key].max}</b></span>
        ))}
      </div>
      <div className="ka-contract">
        <div><span>交易逻辑</span><HL text={plan.researchLogic} /></div>
        <div><span>触发条件</span><HL text={plan.triggerConditions} /></div>
        <div><span>仓位规则</span><HL text={plan.positionRule} /></div>
        <div><span>风险点</span><HL text={plan.riskPoints} /></div>
        <div><span>退出规则</span><HL text={plan.exitConditions || plan.stopLoss?.condition} /></div>
        <div><span>失效条件</span><HL text={plan.invalidation} /></div>
        <div><span>验证周期</span>{plan.validationWindow || '未定义'}</div>
      </div>
      {score.missing?.length > 0 && (
        <div className="ka-missing">待补齐：{score.missing.join('、')}</div>
      )}
      <div className="ka-principle">{plan.principle}</div>
    </section>
  )
}

function ExecutionReview({ review }) {
  return (
    <section
      className={'knowledge-action-review-card ' + (review?.attribution || 'pending')}
      aria-label="知行合一真实执行复盘"
    >
      <div className="kar-head">
        <span><Icon name="history" size={13} /> 真实执行复盘</span>
        {review
          ? <strong>执行 {review.executionScore}分</strong>
          : <strong>待执行 / 待验证</strong>}
      </div>
      {review ? (
        <>
          <div className="kar-scores">
            <span>认知 <b>{review.cognitiveScore ?? '—'}</b></span>
            <span>执行 <b>{review.executionScore ?? '—'}</b></span>
            <span>综合 <b>{review.overallScore ?? '—'}</b></span>
            <span>纪律 <b>{review.disciplineVerdict || '待评估'}</b></span>
          </div>
          <div className="kar-attribution">
            <b>{review.attributionLabel}</b>
            <span>{review.summary}</span>
          </div>
          {review.violations?.length > 0 && (
            <div className="kar-violations">纪律偏差：{review.violations.join('、')}</div>
          )}
          {review.luckyProfit && (
            <div className="kar-warning">本次盈利含纪律违规，不作为高质量执行加分。</div>
          )}
        </>
      ) : (
        <div className="kar-pending">
          尚无与本计划关联的真实成交。验证周期结束前，不用短期盈亏提前评价交易质量。
        </div>
      )}
    </section>
  )
}

function FullEvidence({ advice }) {
  const basis = [
    ['news', '消息', advice.newsNote],
    ['macro', '宏观', advice.macroNote],
    ['seat', '席位', advice.seatNote],
    ['theory', '理论', advice.theoryNote],
  ].filter((item) => item[2])
  const risks = [
    ['rev', '反方', advice.bearCase],
    ['warn', '风险', advice.risk],
  ].filter((item) => item[2])
  return (
    <>
      {basis.length > 0 && (
        <div className="advice-basis">
          <div className="advice-basis-title">完整分析依据</div>
          {basis.map(([tone, label, text]) => (
            <div className="ab-row" key={label}>
              <span className={'ab-k ' + tone}>{label}</span>
              <span className="ab-v"><HL text={text} /></span>
            </div>
          ))}
        </div>
      )}
      {risks.length > 0 && (
        <div className="advice-risk">
          {risks.map(([tone, label, text]) => (
            <div className="ab-row" key={label}>
              <span className={'ab-k ' + tone}>{label}</span>
              <span className="ab-v"><HL text={text} /></span>
            </div>
          ))}
        </div>
      )}
      {advice.confidenceReason && (
        <div className="advice-confidence-detail">
          信心：{advice.confidence || '—'}（{advice.confidenceReason}）
        </div>
      )}
    </>
  )
}

function TGridExperiment({ experiment }) {
  if (!experiment?.eligible || !experiment.levels?.length) return null
  return (
    <section className="t-grid-experiment" aria-label="受限做T区间实验">
      <div className="ka-head">
        <span><Icon name="activity" size={13} /> 做T区间实验</span>
        <strong>最多{experiment.maximumRounds}轮 · {experiment.restoreBy}前复原</strong>
      </div>
      <div className="t-grid-levels">
        {experiment.levels.map((level) => (
          <div key={`${level.sequence}:${level.side}`}>
            <span>{level.side === 'BUY' ? '低吸' : '高抛'}</span>
            <b>{level.lots}手 @ {level.price}</b>
            <small>{level.condition}</small>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function AdviceDetails({ advice, review }) {
  return (
    <div className="advice-deep-body">
      {advice.reasoning && <Reasoning text={advice.reasoning} />}
      {advice.reason && <div className="advice-detail-reason"><HL text={advice.reason} /></div>}
      <KnowledgeAction advice={advice} />
      <TGridExperiment experiment={advice.tGridExperiment} />
      {advice.knowledgeActionPlan && <ExecutionReview review={review} />}
      <FullEvidence advice={advice} />
    </div>
  )
}
