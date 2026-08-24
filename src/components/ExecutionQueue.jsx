import { useMemo, useState } from 'react'

import { executionTriggerDirection } from '../../shared/executionTrigger'
import { planStore } from '../planStore'
import Icon from './Icon'

const STATUS = {
  ARMED: { label: '等待条件', tone: 'waiting' },
  ALERTED: { label: '价格已触发', tone: 'alerted' },
  USER_CONFIRMED: { label: '已确认待记录', tone: 'confirmed' },
  PARTIALLY_RECORDED: { label: '部分成交', tone: 'partial' },
  COMPLETED: { label: '已完成', tone: 'completed' },
  CANCELED: { label: '已取消', tone: 'terminal' },
  EXPIRED: { label: '已过期', tone: 'terminal' },
}

function money(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `¥${Math.round(number).toLocaleString('zh-CN')}`
}

function dateTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function planCondition(plan) {
  const price = Number(plan.triggerPrice ?? plan.referencePrice)
  const priceText = Number.isFinite(price) && price > 0
    ? `${price}元`
    : '条件价'
  const direction = executionTriggerDirection(plan)
  if (direction === 'IMMEDIATE') return '现在可处理'
  if (direction === 'LTE') {
    return plan.side === 'SELL'
      ? `跌至${priceText}时提醒`
      : `回落至${priceText}时提醒`
  }
  if (direction === 'GTE') {
    return plan.side === 'SELL'
      ? `反弹至${priceText}时提醒`
      : `突破${priceText}时提醒`
  }
  return `到达${priceText}时提醒`
}

function methodLabel(plan) {
  return {
    SINGLE_LIMIT: '建议一次处理',
    SLICED_LIMIT: '建议分批处理',
    TWAP_REFERENCE: '建议分时处理',
    VWAP_REFERENCE: '建议跟随成交量处理',
    ICEBERG_REFERENCE: '建议拆分处理',
  }[plan.executionMethod?.type] || '手动处理'
}

function planStatusDetail(plan) {
  if (['CANCELED', 'EXPIRED'].includes(plan.status)) {
    const detail = [...(plan.transitions || [])]
      .reverse()
      .find((item) => item?.to === plan.status)?.detail
    if (detail) return detail
  }
  return `${methodLabel(plan)} · ${dateTime(plan.validUntil)}前有效`
}

function QueueRow({ plan, attribution, onOpen }) {
  const [price, setPrice] = useState(
    String(plan.referencePrice || ''),
  )
  const [lots, setLots] = useState(
    String(Math.max(1, Number(plan.remainingLots) || 1)),
  )
  const [error, setError] = useState('')
  const status = STATUS[plan.status] || {
    label: plan.status,
    tone: 'waiting',
  }
  const canRecord = ['USER_CONFIRMED', 'PARTIALLY_RECORDED']
    .includes(plan.status)

  const record = () => {
    const result = planStore.recordExecutionPlanTrade(
      plan.planId,
      Number(price),
      Number(lots),
    )
    if (!result?.ok) {
      setError(result?.error || '成交记录失败')
      return
    }
    setError('')
  }

  return (
    <div className={`execution-queue-row ${status.tone}`}>
      <button
        type="button"
        className="execution-queue-stock"
        onClick={() => onOpen?.(plan.code, plan.name)}
      >
        <strong>{plan.name || plan.code}</strong>
        <small>{plan.code}</small>
      </button>
      <div className="execution-queue-action">
        <span>{plan.actionLabel || plan.action}</span>
        <b>
          {plan.remainingLots}/{plan.targetLots}手
        </b>
      </div>
      <div className="execution-queue-trigger">
        <span>{planCondition(plan)}</span>
        <small>{plan.trigger || '到达条件后提醒你确认'}</small>
        <small>{planStatusDetail(plan)}</small>
      </div>
      <div className="execution-queue-cost">
        <span>{plan.side === 'BUY' ? '占用现金' : '预计净回笼'}</span>
        <b>
          {money(
            plan.side === 'BUY'
              ? plan.reservedCash
              : plan.expectedNetProceeds,
          )}
        </b>
        {attribution?.totalFees != null && (
          <small>实际费用 {money(attribution.totalFees)}</small>
        )}
      </div>
      <div className="execution-queue-status">
        <span className={`execution-status ${status.tone}`}>
          {status.label}
        </span>
        {plan.status === 'ALERTED' && (
          <button
            type="button"
            className="btn tiny"
            onClick={() => planStore.confirmExecutionPlan(plan.planId)}
          >
            <Icon name="check" size={13} /> 确认准备
          </button>
        )}
        {canRecord && (
          <div className="execution-fill-form">
            <input
              aria-label={`${plan.name || plan.code}成交价`}
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
            <input
              aria-label={`${plan.name || plan.code}成交手数`}
              inputMode="numeric"
              value={lots}
              onChange={(event) => setLots(event.target.value)}
            />
            <button type="button" className="btn tiny" onClick={record}>
              <Icon name="edit" size={13} /> 记录成交
            </button>
          </div>
        )}
        <button
          type="button"
          className="icon-btn execution-cancel"
          aria-label={`移除${plan.name || plan.code}手动操作计划`}
          title="移除计划"
          onClick={() => planStore.dismissExecutionPlan(plan.planId)}
        >
          <Icon name="trash" size={13} />
        </button>
        {error && <small className="execution-error">{error}</small>}
      </div>
    </div>
  )
}

export default function ExecutionQueue({
  plans = [],
  attributions = [],
  onOpen,
}) {
  const visible = useMemo(() => {
    const available = plans.filter((plan) => !plan.dismissedAt)
    const active = available.filter((plan) =>
      ['ARMED', 'ALERTED', 'USER_CONFIRMED', 'PARTIALLY_RECORDED']
        .includes(plan.status)
    )
    const terminal = available.filter((plan) =>
      ['COMPLETED', 'CANCELED', 'EXPIRED'].includes(plan.status)
    ).slice(0, 6)
    return [...active, ...terminal]
  }, [plans])
  const attributionByPlan = useMemo(
    () => new Map(
      attributions
        .filter((item) => item?.planId)
        .map((item) => [item.planId, item]),
    ),
    [attributions],
  )

  if (!visible.length) return null
  return (
    <section className="panel execution-queue" aria-label="待执行计划">
      <div className="panel-head">
        <div className="execution-queue-heading">
          <div className="panel-title">
            <Icon name="checkSquare" size={16} /> 待执行计划
          </div>
          <small>这里只提醒，不会自动交易；成交后再手动记录。</small>
        </div>
        <div className="execution-queue-summary">
          <span>进行中 <b>{visible.filter((plan) => ![
            'COMPLETED',
            'CANCELED',
            'EXPIRED',
          ].includes(plan.status)).length}</b></span>
          <span>历史 <b>{visible.filter((plan) => [
            'COMPLETED',
            'CANCELED',
            'EXPIRED',
          ].includes(plan.status)).length}</b></span>
        </div>
      </div>
      <div className="execution-queue-list">
        {visible.map((plan) => (
          <QueueRow
            key={plan.planId}
            plan={plan}
            attribution={attributionByPlan.get(plan.planId)}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  )
}
