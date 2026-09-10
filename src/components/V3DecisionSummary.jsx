import { useEffect, useState } from 'react'
import { v3DecisionPresentation } from '../../shared/v3DecisionPresentation.js'
import { loadV3Explanation } from '../v3Explanation.js'
import Icon from './Icon'

export default function V3DecisionSummary({
  advice, holdingLots = 0, stopPrice = null, managed = true,
  loading = false, detailed = false, view: preparedView, currentPrice,
  sellableLots = null, code = '',
}) {
  const [expanded, setExpanded] = useState(false)
  const decisionId = advice?.decisionPlan?.decisionId || ''
  const savedExplanation = advice?.v3Explanation?.decisionId === decisionId
    ? advice.v3Explanation
    : null
  const savedExplanationKey = [
    decisionId,
    savedExplanation?.status,
    savedExplanation?.generatedAt,
  ].join(':')
  const [explanation, setExplanation] = useState(savedExplanation)
  const [explanationLoading, setExplanationLoading] = useState(false)
  const [explanationError, setExplanationError] = useState('')
  useEffect(() => {
    setExplanation(savedExplanation)
    setExplanationError('')
    setExplanationLoading(false)
  }, [savedExplanationKey])
  const view = preparedView || v3DecisionPresentation({
    advice, holdingLots, stopPrice, managed, loading, currentPrice, sellableLots,
  })
  const score = advice?.selectedV3Plan?.opportunityScore
  const probability = (value) => value != null && Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(1)}%` : '暂无'
  const requestExplanation = async () => {
    if (!code || !decisionId || explanationLoading) return
    setExplanationLoading(true)
    setExplanationError('')
    try {
      setExplanation(await loadV3Explanation(code, decisionId))
    } catch (error) {
      setExplanationError(error?.message || '模型解读暂不可用')
    } finally {
      setExplanationLoading(false)
    }
  }
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
              {explanation?.status === 'ready' ? (
                <div className="v3-ai-explanation" aria-label="白话解读">
                  <p><b>为什么</b>{explanation.summary}</p>
                  <p><b>最强反方</b>{explanation.counterCase}</p>
                  <p><b>何时失效</b>{explanation.invalidation}</p>
                  <p><b>证据缺口</b>{explanation.evidenceGap}</p>
                </div>
              ) : (
                <button
                  type="button"
                  className="v3-explain-btn"
                  disabled={!code || !decisionId || explanationLoading}
                  aria-busy={explanationLoading}
                  onClick={requestExplanation}
                >
                  <Icon
                    name={explanationLoading ? 'refresh' : 'spark'}
                    className={explanationLoading ? 'spin' : ''}
                    size={13}
                  />
                  {explanationLoading ? '正在解读' : '白话解读'}
                </button>
              )}
              {(explanationError || explanation?.status === 'failed') && (
                <p className="v3-explanation-error" role="status">
                  {explanationError || explanation.error}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
