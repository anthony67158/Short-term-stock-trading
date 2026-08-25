import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api } from '../apiBase'
import { authStore } from '../authStore'
import { getAllAdvice, subscribeAdvice } from '../adviceCache'
import { openStockDetail } from '../detailStore'
import { usePlanStore } from '../planStore'
import { accountCredentialHeaders } from '../../shared/accountCredentials.js'
import { buildStrategyResearchView } from '../../shared/strategyResearch.js'
import { buildStrategyRadar } from '../../shared/strategyRadar.js'
import Icon from './Icon'
import './StrategyResearchPanel.css'

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
  if (!value.samples) {
    return (
      <span className="strategy-empty-value">
        {value.pending ? `${value.pending} 条验证中` : '待积累'}
      </span>
    )
  }
  return (
    <span className="strategy-metric-stack">
      <b>{value.samples} 条</b>
      <small>
        收益 {pct(value.returnPct)} · 盈亏效率 {number(value.profitFactor)}
      </small>
      {!!value.pending && <small>{value.pending} 条等待结算</small>}
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

function impactTone(item) {
  if (['REDUCE', 'EXIT', 'T_SELL_FIRST'].includes(item.action)) {
    return 'defensive'
  }
  if (item.canIncreaseRisk) return 'opportunity'
  if (item.action === 'HOLD') return 'hold'
  return 'watch'
}

function impactNote(item) {
  if (['REDUCE', 'EXIT', 'T_SELL_FIRST'].includes(item.action)) {
    return '降低风险不等待策略晋级，仍以止损与可卖数量为准'
  }
  if (item.canIncreaseRisk) {
    return '策略与当前条件均已通过，仍需你手动确认'
  }
  if (['BUY', 'ADD', 'T_BUY_FIRST'].includes(item.action)) {
    return '当前只作条件参考，不自动增加仓位'
  }
  return item.strategyId
    ? '等待价格、量能或资金进一步确认'
    : '等待下一次军师研判补齐策略匹配'
}

function prioritizedImpacts(items, limit = 5) {
  return [...(items || [])]
    .sort((left, right) =>
      Number(Boolean(right.strategyId)) - Number(Boolean(left.strategyId))
      || Number(right.signalPassed) - Number(left.signalPassed)
      || Number(right.generatedAt || 0) - Number(left.generatedAt || 0)
    )
    .slice(0, limit)
}

function RadarImpactList({
  title,
  icon,
  items,
  empty,
}) {
  const visible = prioritizedImpacts(items)
  return (
    <section className="strategy-radar-impact" aria-label={title}>
      <header>
        <span><Icon name={icon} size={15} />{title}</span>
        <b>{items.length}</b>
      </header>
      {visible.length ? (
        <div className="strategy-radar-impact-list">
          {visible.map((item) => (
            <button
              type="button"
              key={`${item.scope}:${item.code}`}
              className="strategy-radar-impact-row"
              onClick={() => openStockDetail(item.code, item.name)}
              aria-label={`查看${item.name}策略影响`}
            >
              <span className="strategy-radar-stock">
                <b>{item.name}</b>
                <small>{item.code} · {item.strategyName}</small>
              </span>
              <span
                className="strategy-radar-action"
                data-tone={impactTone(item)}
              >
                {item.actionLabel}
              </span>
              <span className="strategy-radar-instruction">
                {item.instruction}
              </span>
              <small className="strategy-radar-policy">
                {impactNote(item)}
              </small>
              <Icon
                name="chevronRight"
                size={14}
                className="strategy-radar-chevron"
              />
            </button>
          ))}
        </div>
      ) : (
        <div className="strategy-radar-empty">{empty}</div>
      )}
      {items.length > visible.length && (
        <div className="strategy-radar-more">
          另有 {items.length - visible.length} 只，可在持仓页查看
        </div>
      )}
    </section>
  )
}

export default function StrategyResearchPanel() {
  const book = usePlanStore()
  const [adviceRevision, setAdviceRevision] = useState(0)
  const [state, setState] = useState({
    loading: true,
    error: '',
    catalog: null,
    governance: null,
  })
  const requestRef = useRef(null)

  useEffect(
    () => subscribeAdvice(() =>
      setAdviceRevision((current) => current + 1)
    ),
    [],
  )

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
  const currentAdvice = useMemo(
    () => getAllAdvice(),
    [adviceRevision],
  )
  const radar = useMemo(
    () => buildStrategyRadar({
      holdings: book.holding,
      watchlist: book.plan,
      advice: currentAdvice,
      governance: state.governance || {},
    }),
    [
      book.holding,
      book.plan,
      currentAdvice,
      state.governance,
    ],
  )
  const observedSamples = view.rows.reduce(
    (sum, row) => sum + row.shadow.samples,
    0,
  )
  const pendingSamples = view.rows.reduce(
    (sum, row) => sum + row.shadow.pending,
    0,
  )

  return (
    <section className="panel strategy-research-panel" aria-label="今日策略雷达">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="gauge" size={16} /> 今日策略雷达
        </div>
        <div className="strategy-research-actions">
          {view.rows.length > 0 && (
            <div className="strategy-research-summary" aria-label="今日策略摘要">
              <span>持仓动作 <b>{radar.summary.holdingActions}</b></span>
              <span>买入候选 <b>{radar.summary.watchCandidates}</b></span>
              <span>已验证 <b>{observedSamples}</b></span>
            </div>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="刷新今日策略雷达"
            title="刷新今日策略雷达"
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
          正在读取当前策略与验证结果…
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
        <>
          <div className="strategy-radar-overview">
            <div>
              <span>当前市场</span>
              <strong>{radar.marketLabel}</strong>
              <small>随行情切换策略，不固定押一种模式</small>
            </div>
            <div>
              <span>当前主参考</span>
              <strong>
                {radar.primaryStrategy?.name || '暂无明确主策略'}
              </strong>
              <small>
                {radar.primaryStrategy
                  ? `覆盖 ${radar.primaryStrategy.totalMatches} 只股票`
                  : '等待最新建议形成有效匹配'}
              </small>
            </div>
            <div>
              <span>执行原则</span>
              <strong>灵活判断，严格控仓</strong>
              <small>机会可动态调整，止损与真实可卖数量不放松</small>
            </div>
          </div>

          <div
            className={
              'strategy-radar-notice'
              + (view.summary.active ? ' active' : '')
            }
          >
            <Icon
              name={view.summary.active ? 'check' : 'info'}
              size={15}
            />
            <span>
              {view.summary.active
                ? `已有 ${view.summary.active} 套策略通过验证，可在条件匹配时参与仓位判断。`
                : '当前没有通过完整验证的加仓策略。系统仍会筛选机会，但买入只作条件参考；减仓和止损继续按风险优先。'}
            </span>
          </div>

          <div className="strategy-radar-impact-grid">
            <RadarImpactList
              title="对当前持仓"
              icon="wallet"
              items={radar.holdings}
              empty="当前没有持仓需要策略处理"
            />
            <RadarImpactList
              title="对自选买入"
              icon="star"
              items={radar.watchlist}
              empty="当前没有自选股进入策略观察"
            />
          </div>

          <details className="strategy-research-details">
            <summary>
              <span>
                <Icon name="chart" size={14} />
                验证明细
              </span>
              <small>
                模拟观察 {observedSamples} · 等待结算 {pendingSamples}
                {' · '}未通过 {view.summary.rejected}
                {' · '}待验证 {view.summary.draft}
              </small>
              <Icon name="chevronDown" size={14} />
            </summary>
            <div className="strategy-research-scroll">
              <table className="strategy-research-table">
                <thead>
                  <tr>
                    <th>策略</th>
                    <th>状态</th>
                    <th>适用市场</th>
                    <th>回测</th>
                    <th>模拟观察</th>
                    <th>真实成交</th>
                    <th>验证状态</th>
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
          </details>
        </>
      )}
    </section>
  )
}
