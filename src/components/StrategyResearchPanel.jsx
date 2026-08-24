import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../apiBase'
import { authStore } from '../authStore'
import { accountCredentialHeaders } from '../../shared/accountCredentials.js'
import { buildStrategyResearchView } from '../../shared/strategyResearch.js'
import Icon from './Icon'

const REFRESH_MS = 5 * 60 * 1000

function pct(value) {
  if (value == null || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`
}

function number(value) {
  if (value == null || value === '') return '—'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '—'
}

function BacktestMetric({ value }) {
  if (!value.available) return <span className="strategy-empty-value">待回测</span>
  return (
    <span className="strategy-metric-stack">
      <b className={value.returnPct > 0 ? 'red' : value.returnPct < 0 ? 'green' : ''}>
        {pct(value.returnPct)}
      </b>
      <small>
        {value.positiveFolds}/{value.folds}个阶段通过 · 回撤 {pct(value.drawdownPct)}
      </small>
      <small>
        沪深300 {pct(value.csi300ExcessPct)} · 中证1000 {pct(value.csi1000ExcessPct)}
      </small>
    </span>
  )
}

function ShadowMetric({ value }) {
  if (!value.samples) return <span className="strategy-empty-value">待积累</span>
  return (
    <span className="strategy-metric-stack">
      <b>{value.samples} 条</b>
      <small>
        收益 {pct(value.returnPct)} · 盈亏效率 {number(value.profitFactor)}
      </small>
    </span>
  )
}

function RealMetric({ value }) {
  if (!value.samples) return <span className="strategy-empty-value">待成交</span>
  return (
    <span className="strategy-metric-stack">
      <b>{value.samples} 笔</b>
      <small>
        稳健胜率 {number(value.posteriorWinRate)}% · 盈亏效率 {number(value.profitFactor)}
      </small>
    </span>
  )
}

export default function StrategyResearchPanel() {
  const [state, setState] = useState({
    loading: true,
    error: '',
    catalog: null,
    governance: null,
  })
  const requestRef = useRef(null)

  const load = useCallback(async () => {
    if (requestRef.current) requestRef.current.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const timeout = setTimeout(() => controller.abort(), 12000)
    setState((current) => ({ ...current, loading: true, error: '' }))
    try {
      const credentials = authStore.getCreds()
      const headers = accountCredentialHeaders(credentials)
      const [catalogResponse, governanceResponse] = await Promise.all([
        fetch(api('/api/strategy_specs'), {
          cache: 'no-store',
          signal: controller.signal,
        }),
        fetch(api('/api/strategy_governance'), {
          cache: 'no-store',
          headers,
          signal: controller.signal,
        }),
      ])
      if (!catalogResponse.ok || !governanceResponse.ok) {
        throw new Error(
          `策略研究接口异常(${catalogResponse.status}/${governanceResponse.status})`,
        )
      }
      const [catalog, governancePayload] = await Promise.all([
        catalogResponse.json(),
        governanceResponse.json(),
      ])
      if (!catalog?.ok || !governancePayload?.ok) {
        throw new Error(
          catalog?.error
          || governancePayload?.error
          || '策略研究数据不可用',
        )
      }
      setState({
        loading: false,
        error: '',
        catalog,
        governance: governancePayload.governance,
      })
    } catch (error) {
      if (error?.name === 'AbortError') return
      setState((current) => ({
        ...current,
        loading: false,
        error: String(error?.message || error),
      }))
    } finally {
      clearTimeout(timeout)
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      clearInterval(timer)
      if (requestRef.current) requestRef.current.abort()
    }
  }, [load])

  const view = useMemo(
    () => buildStrategyResearchView({
      catalog: state.catalog || {},
      governance: state.governance || {},
    }),
    [state.catalog, state.governance],
  )

  return (
    <section className="panel strategy-research-panel" aria-label="策略研究">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="gauge" size={16} /> 策略研究
        </div>
        <div className="strategy-research-actions">
          {view.rows.length > 0 && (
            <div className="strategy-research-summary" aria-label="策略状态汇总">
              <span>已启用 <b>{view.summary.active}</b></span>
              <span>模拟观察 <b>{view.summary.shadow}</b></span>
              <span>未通过 <b>{view.summary.rejected}</b></span>
              <span>待验证 <b>{view.summary.draft}</b></span>
            </div>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="刷新策略研究"
            title="刷新策略研究"
            disabled={state.loading}
            onClick={load}
          >
            <Icon name="refresh" size={14} className={state.loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {state.loading && !view.rows.length && (
        <div className="strategy-research-state" role="status">
          <Icon name="refresh" size={14} className="spin" />
          正在读取策略规则与上线状态…
        </div>
      )}
      {state.error && !view.rows.length && (
        <div className="strategy-research-state error" role="alert">
          <Icon name="info" size={14} />
          <span>{state.error}</span>
          <button type="button" className="btn tiny" onClick={load}>重试</button>
        </div>
      )}
      {view.rows.length > 0 && (
        <div className="strategy-research-scroll">
          <table className="strategy-research-table">
            <thead>
              <tr>
                <th>策略</th>
                <th>状态</th>
                <th>适用市场</th>
                <th>回测</th>
                <th>模拟表现</th>
                <th>真实成交</th>
                <th>上线状态与原因</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.strategyId}>
                  <td>
                    <span className="strategy-name">{row.name}</span>
                    <small>{row.familyLabel} · {row.signalTimeframe} → {row.executionTimeframe}</small>
                  </td>
                  <td>
                    <span className={`strategy-status ${row.stateTone}`}>
                      {row.stateLabel}
                    </span>
                  </td>
                  <td>
                    <span className="strategy-regimes">
                      {row.eligibleRegimes.join(' / ')}
                    </span>
                    <small>{row.horizon}</small>
                  </td>
                  <td><BacktestMetric value={row.backtest} /></td>
                  <td><ShadowMetric value={row.shadow} /></td>
                  <td><RealMetric value={row.real} /></td>
                  <td>
                    <span className="strategy-version">
                      {row.versionLabel}
                    </span>
                    <small>{row.modelLabel}</small>
                    <small className="strategy-blocker">
                      {row.blockerText || '上线条件已满足'}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
