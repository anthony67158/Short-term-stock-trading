import { useMemo, useState } from 'react'

import { planStore } from '../planStore'
import Icon from './Icon'

const STATUS = {
  ARMED: { label: '等待条件', tone: 'waiting' },
  ALERTED: { label: '已到价', tone: 'alerted' },
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
          {' · '}
          {plan.referencePrice || '—'}元
        </b>
      </div>
      <div className="execution-queue-trigger">
        <span>{plan.trigger || '等待价格条件'}</span>
        <small>
          {plan.executionMethod?.label || '单笔限价'}
          {' · '}
          {dateTime(plan.validUntil)}失效
        </small>
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
            <Icon name="check" size={13} /> 确认执行
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
        {!['COMPLETED', 'CANCELED', 'EXPIRED'].includes(plan.status) && (
          <button
            type="button"
            className="icon-btn execution-cancel"
            aria-label={`取消${plan.name || plan.code}执行计划`}
            title="取消执行计划"
            onClick={() => planStore.cancelExecutionPlan(plan.planId)}
          >
            <Icon name="close" size={13} />
          </button>
        )}
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
    const active = plans.filter((plan) =>
      ['ARMED', 'ALERTED', 'USER_CONFIRMED', 'PARTIALLY_RECORDED']
        .includes(plan.status)
    )
    const terminal = plans.filter((plan) =>
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
    <section className="panel execution-queue" aria-label="人工执行队列">
      <div className="panel-head">
        <div className="panel-title">
          <Icon name="checkSquare" size={16} /> 人工执行队列
        </div>
        <div className="execution-queue-summary">
          <span>待处理 <b>{visible.filter((plan) => ![
            'COMPLETED',
            'CANCELED',
            'EXPIRED',
          ].includes(plan.status)).length}</b></span>
          <span>已完成 <b>{visible.filter(
            (plan) => plan.status === 'COMPLETED',
          ).length}</b></span>
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
