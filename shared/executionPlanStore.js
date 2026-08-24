import {
  recordExecutionFill,
  refreshExecutionPlan,
  transitionExecutionPlan,
} from './executionPlan.js'

function updatedAt(plan) {
  return Number(plan?.updatedAt || plan?.createdAt) || 0
}

function preferPlan(current, candidate) {
  if (!current) return candidate
  const currentFilled = Number(current.filledLots) || 0
  const candidateFilled = Number(candidate.filledLots) || 0
  if (candidateFilled !== currentFilled) {
    return candidateFilled > currentFilled ? candidate : current
  }
  if (
    current.status === 'COMPLETED'
    || candidate.status === 'COMPLETED'
  ) {
    return candidate.status === 'COMPLETED' ? candidate : current
  }
  const currentTransitions = Array.isArray(current.transitions)
    ? current.transitions.length
    : 0
  const candidateTransitions = Array.isArray(candidate.transitions)
    ? candidate.transitions.length
    : 0
  if (candidateTransitions !== currentTransitions) {
    return candidateTransitions > currentTransitions
      ? candidate
      : current
  }
  return updatedAt(candidate) >= updatedAt(current)
    ? candidate
    : current
}

export function mergeExecutionPlans(primary = [], secondary = []) {
  const merged = new Map()
  for (const plan of [...primary, ...secondary]) {
    if (!plan?.planId || plan.schemaVersion !== 'execution-plan.v1') continue
    const current = merged.get(plan.planId)
    merged.set(
      plan.planId,
      structuredClone(preferPlan(current, plan)),
    )
  }
  return [...merged.values()]
    .sort((left, right) => updatedAt(right) - updatedAt(left))
    .slice(0, 200)
}

export function upsertExecutionPlan(plans, plan) {
  return mergeExecutionPlans(plans, [plan])
}

export function mergeExecutionAttributions(
  primary = [],
  secondary = [],
) {
  const merged = new Map()
  for (const record of [...primary, ...secondary]) {
    if (
      !record?.planId
      || record.schemaVersion !== 'execution-attribution.v1'
    ) continue
    const current = merged.get(record.planId)
    const currentEligible = current?.learningEligible === true
    const recordEligible = record.learningEligible === true
    const preferRecord = (
      !current
      || (recordEligible && !currentEligible)
      || (
        recordEligible === currentEligible
        && updatedAt(record) >= updatedAt(current)
      )
    )
    if (preferRecord) {
      merged.set(record.planId, structuredClone(record))
    }
  }
  return [...merged.values()]
    .sort((left, right) => updatedAt(right) - updatedAt(left))
    .slice(0, 500)
}

export function transitionExecutionPlanInList(
  plans,
  planId,
  event,
  context = {},
) {
  let changed = false
  const output = (plans || []).map((plan) => {
    if (plan?.planId !== planId) return plan
    changed = true
    return transitionExecutionPlan(plan, event, context)
  })
  if (!changed) throw new Error('执行计划不存在')
  return output
}

export function dismissExecutionPlanInList(
  plans,
  planId,
  now = Date.now(),
) {
  let changed = false
  const output = (plans || []).map((plan) => {
    if (plan?.planId !== planId) return plan
    changed = true
    const active = [
      'DRAFT',
      'ARMED',
      'ALERTED',
      'USER_CONFIRMED',
      'PARTIALLY_RECORDED',
    ].includes(plan.status)
    const canceled = active
      ? transitionExecutionPlan(plan, 'CANCEL', {
          now,
          reason: '用户移除手动操作计划',
        })
      : structuredClone(plan)
    return {
      ...canceled,
      dismissedAt: Number(now) || Date.now(),
      updatedAt: Number(now) || Date.now(),
    }
  })
  if (!changed) throw new Error('执行计划不存在')
  return output
}

export function refreshExecutionPlanList(
  plans,
  {
    quoteMap = {},
    accountRevision = null,
    accountTradeFingerprint = '',
    now = Date.now(),
  } = {},
) {
  return (plans || []).map((plan) => refreshExecutionPlan(plan, {
    now,
    accountRevision,
    accountTradeFingerprint,
    price: quoteMap?.[plan.code]?.price,
  }))
}

export function recordExecutionFillInList(
  plans,
  planId,
  fill,
) {
  let changed = false
  const output = (plans || []).map((plan) => {
    if (plan?.planId !== planId) return plan
    changed = true
    return recordExecutionFill(plan, fill)
  })
  if (!changed) throw new Error('执行计划不存在')
  return output
}

export function activeExecutionPlanForTrade(
  plans,
  {
    code,
    side,
    executionPlanId = '',
  } = {},
) {
  const candidates = (plans || []).filter((plan) =>
    plan?.schemaVersion === 'execution-plan.v1'
    && plan.code === code
    && plan.side === side
    && ['USER_CONFIRMED', 'PARTIALLY_RECORDED'].includes(plan.status)
  )
  if (executionPlanId) {
    return candidates.find(
      (plan) => plan.planId === executionPlanId,
    ) || null
  }
  return candidates.sort(
    (left, right) => updatedAt(right) - updatedAt(left),
  )[0] || null
}

export function expireExecutionPlansForAccountChange(
  plans,
  {
    exceptPlanId = '',
    now = Date.now(),
  } = {},
) {
  return (plans || []).map((plan) => {
    if (
      plan?.planId === exceptPlanId
      || ![
        'DRAFT',
        'ARMED',
        'ALERTED',
        'USER_CONFIRMED',
        'PARTIALLY_RECORDED',
      ]
        .includes(plan?.status)
    ) return plan
    return transitionExecutionPlan(plan, 'EXPIRE', {
      now,
      reason: '账户交易事实已变化，旧计划需重新编译',
    })
  })
}
