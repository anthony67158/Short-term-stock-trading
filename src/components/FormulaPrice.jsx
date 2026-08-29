import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadStockFormulaPrice,
} from '../formulaSelectionClient.js'
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
  return (
    <section className="formula-price-panel" aria-label="公式价位">
      <div className="formula-price-head">
        <div>
          <strong>公式价位</strong>
          <span>独立算法计算 · 军师次级参考</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={refreshFormulaPrice}
          disabled={state.loading}
          aria-label="刷新公式价位"
          title="刷新公式价位"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {state.loading && (
        <div className="formula-price-state" role="status">
          正在计算唯一主路径…
        </div>
      )}
      {!state.loading && state.error && (
        <div className="formula-price-state error" role="alert">
          {state.error}
        </div>
      )}
      {!state.loading && !state.error && decision && (
        <>
          <div className="formula-price-verdict">
            <span className={tone}>{actionLabel}</span>
            <strong>
              {decision.primaryPrice == null
                ? '本轮不给价格'
                : `${PRICE_TYPES[decision.priceType] || '唯一主价位'} `
                  + formatPrice(decision.primaryPrice)}
            </strong>
          </div>
          {decision.primaryPrice != null && (
            <div className="formula-price-grid">
              <div>
                <span>唯一主价位</span>
                <b>{formatPrice(decision.primaryPrice)}</b>
              </div>
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
          <div className="formula-price-meta">
            <span>
              {decision.formulaId || '持仓风险规则'}
            </span>
            <span>
              军师参考权重 {
                Math.round(Number(reference?.effectiveWeight || 0) * 100)
              }%
            </span>
            {decision.executionState === 'T1_LOCKED' && (
              <span className="green">T+1锁定，下一交易日优先处理</span>
            )}
          </div>
          <div className="formula-price-evidence">
            {(decision.evidence || []).slice(0, 3).map((item) => (
              <span key={item}>{item}</span>
            ))}
            {(decision.blockers || []).slice(0, 2).map((item) => (
              <span className="green" key={item}>{item}</span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
