import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadStockFormulaPrice,
} from '../formulaSelectionClient.js'
import {
  buildFormulaPriceExplanation,
} from '../formulaPriceView.js'
import Icon from './Icon'

const ACTIONS = {
  WATCH_BUY: ['等待价格确认', 'gold'],
  HOLD: ['继续持有', 'red'],
  REDUCE: ['到价减仓', 'green'],
  EXIT: ['风险退出', 'green'],
  AVOID: ['当前不适合买', 'muted'],
}

const PRICE_TYPES = {
  PULLBACK_WATCH: '回踩观察价',
  BREAKOUT_WATCH: '突破观察价',
  HARD_STOP: '硬止损价',
  DISTRIBUTION_REDUCE: '减仓参考价',
  TARGET_REDUCE: '目标减仓价',
  RISK_BOUNDARY: '持有风险边界',
}

function formatPrice(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0
    ? number.toFixed(2)
    : '--'
}

export default function FormulaPrice({ code }) {
  const requestRef = useRef(0)
  const [state, setState] = useState({
    loading: true,
    error: '',
    payload: null,
  })

  const refreshFormulaPrice = useCallback(async () => {
    if (!code) return
    const requestId = ++requestRef.current
    setState((current) => ({
      ...current,
      loading: true,
      error: '',
    }))
    try {
      const payload = await loadStockFormulaPrice(code)
      if (requestRef.current !== requestId) return
      setState({ loading: false, error: '', payload })
    } catch (error) {
      if (requestRef.current !== requestId) return
      setState({
        loading: false,
        error: String(error?.message || error),
        payload: null,
      })
    }
  }, [code])

  useEffect(() => {
    refreshFormulaPrice()
    return () => { requestRef.current += 1 }
  }, [refreshFormulaPrice])

  const decision = state.payload?.decision
  const reference = state.payload?.advisorReference
  const [actionLabel, tone] = ACTIONS[decision?.action] || ACTIONS.AVOID
  const hasPrice = decision?.primaryPrice != null
  const explanation = buildFormulaPriceExplanation(state.payload)
  return (
    <section
      className="formula-price-panel"
      aria-labelledby="formula-price-title"
    >
      <div className="formula-price-head">
        <div className="formula-price-title">
          <Icon name="target" size={15} />
          <div>
            <strong id="formula-price-title">公式价位</strong>
            <span>规则计算 · 军师低权重参考</span>
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={refreshFormulaPrice}
          disabled={state.loading}
          aria-busy={state.loading}
          aria-label="刷新公式价位"
          title="刷新公式价位"
        >
          <Icon
            name="refresh"
            size={14}
            className={state.loading ? 'spin' : ''}
          />
        </button>
      </div>
      {state.loading && (
        <div
          className="formula-price-state loading"
          role="status"
          aria-live="polite"
        >
          <Icon name="pulse" size={15} />
          <div>
            <strong>正在计算唯一价位</strong>
            <span>核验行情、技术形态、资金与账户约束</span>
          </div>
        </div>
      )}
      {!state.loading && state.error && (
        <div className="formula-price-state error" role="alert">
          <Icon name="info" size={15} />
          <span>{state.error}</span>
        </div>
      )}
      {!state.loading && !state.error && !decision && (
        <div className="formula-price-state" role="status">
          <Icon name="info" size={15} />
          <span>当前没有可用的公式价位</span>
        </div>
      )}
      {!state.loading && !state.error && decision && (
        <>
          <div className="formula-price-command" data-tone={tone}>
            <span className="formula-price-command-icon">
              <Icon
                name={decision.action === 'WATCH_BUY' ? 'eye' : 'shield'}
                size={16}
              />
            </span>
            <div>
              <strong>{actionLabel}</strong>
              <span>
                {hasPrice
                  ? PRICE_TYPES[decision.priceType] || '唯一主价位'
                  : explanation.computed
                    ? '公式已运行，查看下方原因'
                    : '公式尚未完成计算'}
              </span>
            </div>
            <b data-empty={hasPrice ? undefined : 'true'}>
              {hasPrice
                ? formatPrice(decision.primaryPrice)
                : '暂不操作'}
            </b>
          </div>
          {hasPrice && (
            <div className="formula-price-levels">
              <div>
                <span>止损</span>
                <b className="green">
                  {formatPrice(decision.stopPrice)}
                </b>
              </div>
              <div>
                <span>目标</span>
                <b className="red">
                  {formatPrice(decision.targetPrice)}
                </b>
              </div>
              <div>
                <span>盈亏比</span>
                <b>
                  {decision.riskReward == null
                    ? '--'
                    : `${decision.riskReward}:1`}
                </b>
              </div>
            </div>
          )}
          {decision.action === 'AVOID' && (
            <div className="formula-price-reason" role="note">
              <div className="formula-price-reason-head">
                <span>
                  <Icon name="info" size={13} />
                  为什么暂不买
                </span>
                <small>{explanation.status}</small>
              </div>
              <strong>{explanation.title}</strong>
              {explanation.reasons.length > 0 && (
                <ul>
                  {explanation.reasons.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {(explanation.moreCount > 0 || explanation.alternative) && (
                <small>
                  {explanation.moreCount > 0
                    ? `另有${explanation.moreCount}项未通过`
                    : explanation.alternative}
                </small>
              )}
            </div>
          )}
          <div className="formula-price-meta">
            <span>
              <Icon name="activity" size={12} />
              {explanation.formulaName}
            </span>
            <span>
              <Icon name="scale" size={12} />
              军师参考 {
                Math.round(Number(reference?.effectiveWeight || 0) * 100)
              }%
            </span>
            {decision.executionState === 'T1_LOCKED' && (
              <span className="green">
                <Icon name="clock" size={12} />
                T+1锁定，下一交易日优先处理
              </span>
            )}
          </div>
          <div className="formula-price-evidence">
            {(decision.evidence || []).slice(0, 3).map((item) => (
              <span key={item}>
                <Icon name="check" size={11} />
                {item}
              </span>
            ))}
            {decision.action !== 'AVOID'
              && (decision.blockers || []).slice(0, 2).map((item) => (
              <span className="green" key={item}>
                <Icon name="shield" size={11} />
                {item}
              </span>
              ))}
          </div>
        </>
      )}
    </section>
  )
}
