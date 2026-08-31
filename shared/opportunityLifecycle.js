export const OPPORTUNITY_LIFECYCLE_VERSION =
  'opportunity-lifecycle.v1'

export const OPPORTUNITY_STAGES = Object.freeze([
  'DISCOVERED',
  'WATCHING',
  'ARMED',
  'CONFIRMED',
  'EXECUTING',
  'MANAGED',
  'EXIT_PENDING',
  'CLOSED',
])

const STAGE_LABELS = Object.freeze({
  DISCOVERED: '发现机会',
  WATCHING: '观察条件核验中',
  ARMED: '价格条件监控中',
  CONFIRMED: '条件已确认，待人工执行',
  EXECUTING: '执行记录中',
  MANAGED: '持仓管理',
  EXIT_PENDING: '退出条件监控中',
  CLOSED: '本轮已结束',
})

const TERMINAL_EXECUTION = new Set([
  'COMPLETED',
  'CANCELED',
  'EXPIRED',
])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nextEventFor(stage, lifecycle = {}) {
  if (stage === 'DISCOVERED') return '进入关注队列后开始监控'
  if (stage === 'WATCHING') {
    return '当前不执行；回踩、突破或关键证据变化时重新判断'
  }
  if (stage === 'ARMED') return '价格触发后，由用户确认是否执行'
  if (stage === 'CONFIRMED') return '用户确认计划后，记录真实成交'
  if (stage === 'EXECUTING') return '补录剩余真实成交'
  if (stage === 'MANAGED') return '止盈、止损、做T或换仓条件变化时重新判断'
  if (stage === 'EXIT_PENDING') {
    return lifecycle.sellableTodayQty > 0
      ? '退出条件触发后，由用户人工执行'
      : '受T+1限制，下一交易日优先退出'
  }
  return '本轮已结束；出现新的独立机会后再评估'
}

function executionStage(executionPlan) {
  if (!executionPlan || typeof executionPlan !== 'object') return null
  const status = String(executionPlan.status || '')
  if (status === 'USER_CONFIRMED') return 'CONFIRMED'
  if (status === 'PARTIALLY_RECORDED') return 'EXECUTING'
  if (['ARMED', 'ALERTED'].includes(status)) return 'ARMED'
  if (status !== 'COMPLETED') return null
  return executionPlan.side === 'SELL' ? 'CLOSED' : 'MANAGED'
}

export function deriveOpportunityLifecycle({
  code = '',
  mode = '',
  advice = {},
  tactical = {},
  decisionPlan = {},
  executionPlan = null,
  holdQty = 0,
  sellableTodayQty = 0,
  now = Date.now(),
} = {}) {
  const fromExecution = executionStage(executionPlan)
  const holding = Math.max(0, finite(holdQty) || 0) > 0
  const action = String(
    decisionPlan.action
    || advice.action
    || advice.stance
    || '',
  )
  const actionability = String(
    decisionPlan.actionability || '',
  )
  const deterministicExit = [
    'HARD_STOP',
    'STRUCTURAL_EXIT',
    'TAKE_PROFIT',
    'TRAILING_PROTECT',
  ].includes(String(advice.exitManagement?.kind || ''))
  const riskExit = deterministicExit
    || /EXIT|REDUCE|清仓|减仓|止损|退出/.test(action)
  const riskEntry = /BUY|ADD|买入|建仓|加仓|试错/.test(action)
  let stage = fromExecution

  if (!stage && executionPlan && TERMINAL_EXECUTION.has(
    String(executionPlan.status || ''),
  )) {
    stage = holding ? 'MANAGED' : 'CLOSED'
  }
  if (!stage && holding && riskExit) stage = 'EXIT_PENDING'
  if (!stage && holding && riskEntry && actionability === 'READY') {
    stage = 'ARMED'
  }
  if (!stage && holding) stage = 'MANAGED'
  if (!stage && riskEntry && ['READY', 'MANUAL_PROBE'].includes(
    actionability,
  )) stage = 'ARMED'
  if (!stage && (
    tactical.timing?.state?.startsWith('WAIT_')
    || decisionPlan.action === 'WATCH'
    || advice.pullbackWatchPrice != null
    || advice.breakoutWatchPrice != null
  )) stage = 'WATCHING'
  if (!stage) stage = 'DISCOVERED'

  const lifecycle = {
    schemaVersion: OPPORTUNITY_LIFECYCLE_VERSION,
    code: String(code || ''),
    mode: String(mode || ''),
    stage,
    stageLabel: STAGE_LABELS[stage],
    decisionId: String(decisionPlan.decisionId || ''),
    executionPlanId: String(executionPlan?.planId || ''),
    sellableTodayQty: Math.max(
      0,
      Math.trunc(finite(sellableTodayQty) || 0),
    ),
    terminal: stage === 'CLOSED',
    updatedAt: Number(now),
  }
  lifecycle.nextEvent = nextEventFor(stage, lifecycle)
  return lifecycle
}

export function mergeOpportunityLifecycle(current, candidate) {
  if (!current) return candidate
  if (!candidate) return current
  const sameDecision = (
    current.decisionId
    && current.decisionId === candidate.decisionId
  )
  if (
    sameDecision
    && current.terminal === true
    && candidate.terminal !== true
  ) return current
  if (
    sameDecision
    && Number(current.updatedAt) > Number(candidate.updatedAt)
  ) return current
  return candidate
}
