import { useState } from 'react'
import { v3DecisionPresentation } from '../../shared/v3DecisionPresentation.js'
import Icon from './Icon'

export default function V3DecisionSummary({
  advice, holdingLots = 0, stopPrice = null, managed = true,
  loading = false, detailed = false, view: preparedView, currentPrice,
  sellableLots = null, monitoring = null,
}) {
  const [expanded, setExpanded] = useState(false)
  const view = preparedView || v3DecisionPresentation({
    advice, holdingLots, stopPrice, managed, loading, currentPrice, sellableLots,
  })
  const score = advice?.selectedV3Plan?.opportunityScore
  const probability = (value) => value != null && Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(1)}%` : '暂无'
  return (
    <section className={`v3-decision-summary ${view.tone}`} aria-label="V3操作决策">
      <div className="v3-decision-eyebrow">
        <span>{view.hardStop ? '账本止损' : view.isV3 ? 'V3 决策' : managed ? '等待评估' : '普通收藏'}</span>
        {loading && <Icon name="refresh" className="spin" size={14} />}
      </div>
      <div className="v3-decision-headline">
        <Icon name={view.icon} size={21} />
        <strong>{view.headline}</strong>
      </div>
      <p className="v3-decision-reason">{view.reason}</p>
      <dl className="v3-execution-facts">
        <div><dt>何时操作</dt><dd>{view.timing}</dd></div>
        {view.executable && <div><dt>参考价格</dt><dd>{view.reference}</dd></div>}
        <div><dt>风险边界</dt><dd>{view.protection}</dd></div>
      </dl>
      {monitoring?.rules?.filter((rule) => rule.state === 'OBSERVING').map((rule) => (
        <p className="v3-decision-reason" key={rule.id} role="status">
          {rule.text || '条件持续观察'} · 倒计时 {rule.remainingSeconds} 秒
        </p>
      ))}
      {detailed && (
        <>
          <button type="button" className="v3-evidence-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
            决策依据
          </button>
          {expanded && (
            <div className="v3-decision-evidence">
              <p>成交概率 {probability(score?.pFill)} · 成交后盈利概率 {probability(score?.pWinGivenFill)}</p>
              {score?.expectedNetR != null && <p>费后期望 {score.expectedNetR}R · 尾部损失参考 {score.expectedShortfall10}R</p>}
              <p>{advice?.quantNote || '尚无V3结果。'}</p>
              <p>{advice?.fundNote || '资金数据暂不可用。'}</p>
              {score?.outOfDistribution && <p>部分行情特征超出训练范围，当前预测仍取自V3模型。</p>}
              {advice?.decisionSource?.modelVersion && <p>模型版本 {advice.decisionSource.modelVersion}</p>}
            </div>
          )}
        </>
      )}
    </section>
  )
}
