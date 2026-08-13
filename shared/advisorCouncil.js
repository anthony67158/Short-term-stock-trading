import { sanitizeTradeProposal } from './tradeProposal.js'

const ROLES = new Set(['researcher', 'risk_officer', 'skeptic'])
const VERDICTS = new Set(['support', 'oppose', 'abstain'])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function handsOf(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*手/)
  const number = match ? Number(match[1]) : Number(value)
  return Number.isFinite(number) && number > 0
    ? Math.trunc(number)
    : null
}

function text(value, maximum) {
  return String(value || '').trim().slice(0, maximum)
}

export function sanitizeCouncilOpinion(input = {}) {
  const role = String(input.role || '')
  const verdict = String(input.verdict || '').toLowerCase()
  if (!ROLES.has(role) || !VERDICTS.has(verdict)) return null
  return {
    role,
    verdict,
    confidence: Math.max(
      0,
      Math.min(100, Math.round(finite(input.confidence) || 0)),
    ),
    thesis: text(input.thesis, 240),
    evidence: (Array.isArray(input.evidence) ? input.evidence : [])
      .map((item) => text(item, 120))
      .filter(Boolean)
      .slice(0, 6),
    risks: (Array.isArray(input.risks) ? input.risks : [])
      .map((item) => text(item, 120))
      .filter(Boolean)
      .slice(0, 6),
    veto: role === 'risk_officer' && input.veto === true,
  }
}

export function proposalFromAdvice({
  code,
  name,
  mode,
  advice = {},
} = {}) {
  const actionText = String(advice.action || advice.stance || '')
  let action = null
  let entryPrice = null
  let triggerOp = null
  let quantity = null
  if (mode === 'buy_advice' && !/观望|等待|回避|不建议/.test(actionText)) {
    action = 'buy'
    entryPrice = advice.buyPrice
    triggerOp = 'lte'
    quantity = handsOf(advice.planQtyNum ?? advice.planQty)
  } else if (/加仓|补仓|接回|买回/.test(actionText)) {
    action = 'add'
    entryPrice = advice.addPrice
    triggerOp = 'lte'
    quantity = handsOf(advice.opQty)
  } else if (/减仓/.test(actionText)) {
    action = 'reduce'
    entryPrice = advice.reducePrice ?? advice.stopPrice
    triggerOp = advice.reducePrice != null ? 'gte' : 'lte'
    quantity = handsOf(advice.opQty)
  } else if (/清仓|卖出|止损|离场/.test(actionText)) {
    action = 'sell'
    entryPrice = advice.stopPrice ?? advice.reducePrice
    triggerOp = advice.stopPrice != null ? 'lte' : 'gte'
    quantity = handsOf(advice.opQty)
  }
  if (!action) return null
  return sanitizeTradeProposal({
    id: `council_${code}_${action}`,
    code,
    name,
    action,
    entryPrice,
    targetPrice: advice.targetPrice,
    stopPrice: advice.stopPrice,
    qty: quantity,
    triggerOp,
    reason: advice.reason || advice.actionPlan,
    confirmSignal: advice.exitTiming || advice.timing,
  })
}

function accountBlockers(proposal, account, strategyGate) {
  const blockers = []
  const holdQty = Math.max(0, Math.trunc(finite(account?.holdQty) || 0))
  const sellable = Math.max(0, Math.min(
    holdQty,
    Math.trunc(finite(account?.sellableTodayQty) ?? holdQty),
  ))
  const quantity = Math.max(0, Math.trunc(finite(proposal?.qty) || 0))
  const riskIncreasing = proposal?.action === 'buy'
    || proposal?.action === 'add'
  if (riskIncreasing && strategyGate?.productionEligible !== true) {
    blockers.push('策略尚未通过生产晋级门禁')
  }
  if (proposal?.action === 'buy' && holdQty > 0) {
    blockers.push('已有持仓不能编译为新建仓')
  }
  if (proposal?.action === 'add' && holdQty <= 0) {
    blockers.push('无持仓不能编译为加仓')
  }
  if (
    (proposal?.action === 'reduce' || proposal?.action === 'sell')
    && quantity > sellable
  ) {
    blockers.push('卖出手数超过今日可卖数量')
  }
  if (riskIncreasing) {
    const required = finite(proposal?.entryPrice) * quantity * 100
    const cash = finite(account?.cash)
    if (cash != null && required > cash) blockers.push('可用资金不足')
    const totalAssets = finite(account?.totalAssets)
    const currentPosition = finite(account?.position)
    const stockWeight = finite(account?.stockWeight) || 0
    const plannedWeight = totalAssets > 0 ? required / totalAssets * 100 : 0
    if (currentPosition != null && currentPosition + plannedWeight >= 85) {
      blockers.push('操作后总仓位达到85%风险红线')
    }
    const maximumStockWeight = finite(account?.maxStockWeight) || 25
    if (stockWeight + plannedWeight >= maximumStockWeight) {
      blockers.push('操作后单票占比超过上限')
    }
  }
  return blockers
}

export function compileAdvisorCouncil({
  opinions,
  proposal,
  account = {},
  strategyGate = {},
  evidenceSnapshotId,
  now = Date.now(),
} = {}) {
  const byRole = new Map()
  for (const raw of Array.isArray(opinions) ? opinions : []) {
    const opinion = sanitizeCouncilOpinion(raw)
    if (opinion && !byRole.has(opinion.role)) {
      byRole.set(opinion.role, opinion)
    }
  }
  const normalized = [...byRole.values()]
  const blockers = []
  for (const role of ROLES) {
    if (!byRole.has(role)) blockers.push(`缺少${role}意见`)
  }
  const cleanProposal = sanitizeTradeProposal(proposal)
  if (!cleanProposal) blockers.push('军师建议无法编译为合法交易提案')
  if (!evidenceSnapshotId) blockers.push('缺少统一证据快照')
  const supports = normalized.filter(
    (opinion) => opinion.verdict === 'support',
  ).length
  const opposes = normalized.filter(
    (opinion) => opinion.verdict === 'oppose',
  ).length
  const consensusReached = supports >= 2
  if (!consensusReached) blockers.push('委员会未形成至少两票支持')
  if (byRole.get('risk_officer')?.veto) blockers.push('风险官否决')
  if (cleanProposal) {
    blockers.push(...accountBlockers(cleanProposal, account, strategyGate))
  }
  const uniqueBlockers = [...new Set(blockers)]
  const hardGatePassed = uniqueBlockers.length === 0
  return {
    schemaVersion: 'advisor-council-shadow.v1',
    at: now,
    evidenceSnapshotId: evidenceSnapshotId || null,
    shadowOnly: true,
    actionable: false,
    opinions: normalized,
    proposal: cleanProposal,
    compiled: {
      decision: cleanProposal
        ? hardGatePassed ? 'shadow_candidate' : 'blocked'
        : 'no_trade',
      votes: {
        support: supports,
        oppose: opposes,
        abstain: normalized.length - supports - opposes,
      },
      consensusReached,
      hardGatePassed,
      eligibleForConfirmation: hardGatePassed,
      blockers: uniqueBlockers,
      strategyProductionEligible: strategyGate?.productionEligible === true,
    },
  }
}
