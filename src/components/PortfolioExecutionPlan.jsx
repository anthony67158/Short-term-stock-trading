import Icon from './Icon'
import { openStockDetail } from '../detailStore'

const ACTION_LABELS = {
  reduce: '减持',
  exit: '退出',
  add: '加仓',
  buy: '新买',
}

const SCENARIO_LABELS = {
  strong: '市场转强',
  balanced: '震荡维持',
  weak: '市场转弱',
}

function percent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '--'
}

function money(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(number)
}

function ActionOrder({ order }) {
  const projectedWeightPct = Number.isFinite(
    Number(order.projectedWeightPct),
  ) ? order.projectedWeightPct : order.targetWeightPct
  const requestedTargetWeightPct = Number.isFinite(
    Number(order.requestedTargetWeightPct),
  ) ? order.requestedTargetWeightPct : order.targetWeightPct
  const hasLotGap = Math.abs(
    Number(projectedWeightPct) - Number(requestedTargetWeightPct),
  ) >= 0.2
  return (
    <button
      type="button"
      className="portfolio-execution-order"
      data-action={order.action}
      onClick={() => openStockDetail(order.code, order.name)}
    >
      <span className="portfolio-execution-priority">
        {order.priority}
      </span>
      <span className="portfolio-execution-identity">
        <small>{order.concept}</small>
        <b>{order.name}</b>
        <em>{order.code}</em>
      </span>
      <span
        className="portfolio-execution-action"
        data-action={order.action}
      >
        {ACTION_LABELS[order.action] || order.action}
      </span>
      <span className="portfolio-execution-size">
        <b>{order.estimatedLots} 手</b>
        <small>{money(order.estimatedAmount)}</small>
      </span>
      <span className="portfolio-execution-weight">
        <small>总资产占比</small>
        <b>
          {percent(order.currentWeightPct)}
          <Icon name="chevronRight" size={11} />
          {percent(projectedWeightPct)}
        </b>
        {hasLotGap && (
          <small>模型目标 {percent(requestedTargetWeightPct)}</small>
        )}
      </span>
      <span className="portfolio-execution-price">
        <small>参考执行价</small>
        <b>{order.referencePrice > 0 ? `¥${order.referencePrice}` : '--'}</b>
      </span>
      <span className="portfolio-execution-reason">
        <p>{order.reason}</p>
        {order.trigger && <small>触发：{order.trigger}</small>}
        {order.invalidation && (
          <small>失效：{order.invalidation}</small>
        )}
        {order.t1Blocked && (
          <strong>
            T+1：今日最多卖 {order.sellableLots} 手，剩余
            {' '}{order.remainingLots} 手待解锁
          </strong>
        )}
      </span>
      <Icon name="chevronRight" size={14} />
    </button>
  )
}

function ConceptPlan({ rows = [] }) {
  if (!rows.length) return null
  return (
    <section className="portfolio-concept-plan">
      <div className="portfolio-analysis-section-title">
        <Icon name="layers" size={13} /> 概念调仓前后
      </div>
      <div className="portfolio-concept-plan-table">
        {rows.map((item) => {
          const executable = Number.isFinite(
            Number(item.executableTargetWeightPct),
          )
            ? item.executableTargetWeightPct
            : item.targetWeightPct
          return (
            <div key={item.concept} data-action={item.action}>
            <b>{item.concept}</b>
            <span>{percent(item.currentWeightPct)}</span>
            <Icon name="chevronRight" size={11} />
            <span>{percent(executable)}</span>
            <strong>
              {executable - item.currentWeightPct > 0 ? '+' : ''}
              {percent(executable - item.currentWeightPct)}
            </strong>
            <small>
              {item.reason}
              {Math.abs(executable - item.targetWeightPct) >= 0.2
                ? ` · 模型目标${percent(item.targetWeightPct)}，已按整手/资金修正`
                : ''}
            </small>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ScenarioPlan({ rows = [] }) {
  if (!rows.length) return null
  return (
    <section className="portfolio-scenario-plan">
      <div className="portfolio-analysis-section-title">
        <Icon name="activity" size={13} /> 行情切换方案
      </div>
      <div>
        {rows.map((item) => (
          <article key={item.regime} data-regime={item.regime}>
            <header>
              <b>{SCENARIO_LABELS[item.regime] || item.regime}</b>
              <span>目标仓位 {percent(item.targetPositionPct)}</span>
            </header>
            <p>{item.signal}</p>
            <ul>
              {item.actions.map((action, index) => (
                <li key={index}>{action}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  )
}

export default function PortfolioExecutionPlan({ analysis = {} }) {
  const executionPlan = analysis.executionPlan || {}
  const quality = analysis.quality || { score: 0, missing: [] }
  const orders = executionPlan.orders || []
  const projectedPositionPct = Number.isFinite(
    Number(executionPlan.projectedPositionPct),
  ) ? executionPlan.projectedPositionPct : executionPlan.targetPositionPct
  if (!executionPlan.todayGoal && !orders.length) return null

  return (
    <div className="portfolio-execution">
      <section className="portfolio-execution-summary">
        <div>
          <div className="portfolio-analysis-section-title">
            <Icon name="check" size={13} /> 今日执行清单
          </div>
          <h3>{executionPlan.todayGoal}</h3>
          <p>
            下次复核：{executionPlan.nextReviewTrigger || '等待新证据'}
          </p>
        </div>
        <div className="portfolio-execution-totals">
          <span>预计卖出<b>{money(executionPlan.estimatedSellAmount)}</b></span>
          <span>预计买入<b>{money(executionPlan.estimatedBuyAmount)}</b></span>
          <span>
            执行后仓位
            <b>{percent(projectedPositionPct)}</b>
          </span>
          <span>
            执行后现金
            <b>{percent(100 - projectedPositionPct)}</b>
          </span>
        </div>
        <div
          className="portfolio-execution-quality"
          data-level={quality.score >= 75 ? 'good' : 'warn'}
        >
          <span>执行单完整度</span>
          <b>{quality.score}/100</b>
        </div>
      </section>

      {quality.missing?.length > 0 && (
        <div className="portfolio-execution-warning" role="status">
          <Icon name="info" size={13} />
          <span>{quality.missing.join('；')}</span>
        </div>
      )}

      {orders.length > 0 && (
        <div className="portfolio-execution-list">
          {orders.map((order) => (
            <ActionOrder
              key={`${order.action}-${order.code}`}
              order={order}
            />
          ))}
        </div>
      )}

      <div className="portfolio-execution-secondary">
        <ConceptPlan rows={analysis.conceptActions || []} />
        <ScenarioPlan rows={analysis.scenarioPlan || []} />
      </div>
    </div>
  )
}
