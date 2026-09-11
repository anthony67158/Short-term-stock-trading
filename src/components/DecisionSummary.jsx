import { useEffect, useState } from 'react'
import {
  decisionPresentation,
  decisionPrices,
} from '../../shared/decisionPresentation.js'
import { fmtRaw } from '../format.js'
import { loadDecisionExplanation } from '../decisionExplanation.js'
import Icon from './Icon'
import StrategyPatternEvidence from './StrategyPatternEvidence'

export default function DecisionSummary({
  advice, holdingLots = 0, stopPrice = null, managed = true,
  loading = false, detailed = false, view: preparedView, currentPrice,
  sellableLots = null, code = '',
}) {
  const [expanded, setExpanded] = useState(false)
  const decisionId = advice?.decisionPlan?.decisionId || ''
  const storedExplanation = advice?.decisionExplanation
  const savedExplanation = storedExplanation?.decisionId === decisionId
    ? storedExplanation : null
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
  const view = preparedView || decisionPresentation({
    advice, holdingLots, stopPrice, managed, loading, currentPrice, sellableLots,
  })
  const priceItems = decisionPrices(advice)
  const displayedPriceKeys = new Set(
    priceItems.map((item) => item.key),
  )
  const score = advice?.selectedDecisionPlan?.opportunityScore
  const probability = (value) => value != null && Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(1)}%` : '暂无'
  const requestExplanation = async () => {
    if (!code || !decisionId || explanationLoading) return
    setExplanationLoading(true)
    setExplanationError('')
    try {
      setExplanation(await loadDecisionExplanation(code, decisionId))
    } catch (error) {
      setExplanationError(error?.message || '模型解读暂不可用')
    } finally {
      setExplanationLoading(false)
    }
  }
  return (
    <section className={`decision-summary ${view.tone}`} aria-label="操作决策">
      <div className="decision-eyebrow">
        <span>{view.hardStop ? '账本止损' : view.isDecisionEngine ? '系统决策' : managed ? '等待评估' : '普通收藏'}</span>
        {loading && <Icon name="refresh" className="spin" size={14} />}
      </div>
      <div className="decision-headline">
        <Icon name={view.icon} size={21} />
        <strong>{view.headline}</strong>
      </div>
      <p className="decision-reason">{view.reason}</p>
      {priceItems.length > 0 && (
        <dl className="decision-price-strip" aria-label="复核与执行价位">
          {priceItems.map((item) => (
            <div key={item.key} data-tone={item.tone}>
              <dt>{item.label}</dt>
              <dd>{fmtRaw(item.value)}<small>元</small></dd>
            </div>
          ))}
        </dl>
      )}
      <dl className="decision-execution-facts">
        <div><dt>何时操作</dt><dd>{view.timing}</dd></div>
        {view.executable
          && (detailed || !displayedPriceKeys.has('reference'))
          && <div><dt>参考价格</dt><dd>{view.reference}</dd></div>}
        {(detailed || !displayedPriceKeys.has('stop')) && (
          <div><dt>风险边界</dt><dd>{view.protection}</dd></div>
        )}
      </dl>
      {detailed && (
        <>
          <button type="button" className="decision-evidence-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
            决策依据
          </button>
          {expanded && (
            <div className="decision-evidence">
              <StrategyPatternEvidence pattern={advice?.strategyPattern} />
              <p>成交概率 {probability(score?.pFill)} · 成交后盈利概率 {probability(score?.pWinGivenFill)}</p>
              {score?.expectedNetR != null && <p>费后期望 {score.expectedNetR}R · 尾部损失参考 {score.expectedShortfall10}R</p>}
              <p>{advice?.quantNote || '尚无决策模型结果。'}</p>
              <p>{advice?.fundNote || '资金数据暂不可用。'}</p>
              {score?.outOfDistribution && <p>部分行情特征超出训练范围，当前预测仍取自生产决策模型。</p>}
              {advice?.decisionSource?.modelVersion && <p>模型版本 {advice.decisionSource.modelVersion}</p>}
              {explanation?.status === 'ready' ? (
                <div className="decision-ai-explanation" aria-label="白话解读">
                  <p><b>为什么</b>{explanation.summary}</p>
                  <p><b>最强反方</b>{explanation.counterCase}</p>
                  <p><b>何时失效</b>{explanation.invalidation}</p>
                  <p><b>证据缺口</b>{explanation.evidenceGap}</p>
                </div>
              ) : (
                <button
                  type="button"
                  className="decision-explain-btn"
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
                <p className="decision-explanation-error" role="status">
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
