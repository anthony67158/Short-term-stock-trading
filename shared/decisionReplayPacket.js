import {
  ACTION_VALUE_ARBITER_VERSION,
} from './actionValueArbiter.js'
import {
  ACCOUNT_RISK_PROFILE_VERSION,
} from './accountRiskProfiles.js'
import {
  DECISION_ENGINE_POLICY_VERSION,
  buildDecisionAction,
} from './decisionEnginePolicy.js'
import {
  DECISION_STATE_SCHEMA_VERSION,
} from './decisionStateContract.js'
import {
  TARGET_POSITION_MODEL_VERSION,
} from './targetPositionModel.js'

export const DECISION_REPLAY_PACKET_VERSION =
  'decision-replay-packet.v1'
export const DECISION_REPLAY_RESULT_VERSION =
  'decision-replay-result.v1'

const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|nick(?:name)?|user(?:name|id)|accountSnapshot|holdings?|closed|transactions?|executionPlans?)/i

const CONTRACTS = Object.freeze({
  policy: DECISION_ENGINE_POLICY_VERSION,
  state: DECISION_STATE_SCHEMA_VERSION,
  arbiter: ACTION_VALUE_ARBITER_VERSION,
  targetPosition: TARGET_POSITION_MODEL_VERSION,
  riskProfile: ACCOUNT_RISK_PROFILE_VERSION,
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function text(value, maximum = 160) {
  return String(value || '').trim().slice(0, maximum)
}

function safeClone(value, depth = 0) {
  if (value == null || depth > 10) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') return text(value, 1000)
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item) => safeClone(item, depth + 1))
  }
  if (typeof value !== 'object') return null
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .slice(0, 500)
      .map(([key, item]) => [key, safeClone(item, depth + 1)]),
  )
}

function decisionPayload(payload = {}) {
  return {
    code: text(payload.code, 6),
    name: text(payload.name, 40),
    todayQuote: safeClone(payload.todayQuote),
    holdQty: finite(payload.holdQty),
    sellableTodayQty: finite(payload.sellableTodayQty),
    holdCost: finite(payload.holdCost),
    holdingStopPrice: finite(payload.holdingStopPrice),
    account: {
      cash: finite(payload.account?.cash),
      totalAssets: finite(payload.account?.totalAssets),
      position: finite(payload.account?.position),
      stockWeight: finite(payload.account?.stockWeight),
      maxStockWeight: finite(payload.account?.maxStockWeight),
      complete: payload.account?.complete !== false,
    },
    accountCircuitBreaker: {
      state: text(payload.accountCircuitBreaker?.state, 24) || null,
      allowRiskIncrease:
        payload.accountCircuitBreaker?.allowRiskIncrease !== false,
    },
    market: safeClone(payload.market),
    sectorOpportunity: safeClone(payload.sectorOpportunity),
    stockFund: safeClone(payload.stockFund),
    evidenceIncomplete: payload.evidenceIncomplete === true,
    missingEvidence: safeClone(payload.missingEvidence),
    reviewEvent: safeClone(payload.reviewEvent),
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  )
}

function fingerprint(value) {
  const source = JSON.stringify(stable(value))
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `decision.${(first >>> 0).toString(16).padStart(8, '0')}${
    (second >>> 0).toString(16).padStart(8, '0')
  }`
}

function validatePacket(packet) {
  if (packet?.schemaVersion !== DECISION_REPLAY_PACKET_VERSION) {
    throw new Error('DECISION_REPLAY_VERSION_MISMATCH:packet')
  }
  for (const [name, version] of Object.entries(CONTRACTS)) {
    if (packet.contracts?.[name] !== version) {
      throw new Error(`DECISION_REPLAY_VERSION_MISMATCH:${name}`)
    }
  }
  if (!(finite(packet.evaluatedAt) > 0)) {
    throw new Error('DECISION_REPLAY_EVALUATED_AT_REQUIRED')
  }
  if (!/^\d{6}$/.test(String(packet.input?.payload?.code || ''))) {
    throw new Error('DECISION_REPLAY_CODE_INVALID')
  }
  if (!Array.isArray(packet.input?.plans)) {
    throw new Error('DECISION_REPLAY_PLANS_REQUIRED')
  }
  if (packet.packetFingerprint !== fingerprint({
    schemaVersion: packet.schemaVersion,
    contracts: packet.contracts,
    evaluatedAt: packet.evaluatedAt,
    input: packet.input,
  })) {
    throw new Error('DECISION_REPLAY_FINGERPRINT_MISMATCH')
  }
}

export function buildDecisionReplayPacket({
  payload = {},
  plans = [],
  now = Date.now(),
} = {}) {
  const evaluatedAt = finite(now)
  if (!(evaluatedAt > 0)) {
    throw new Error('DECISION_REPLAY_EVALUATED_AT_REQUIRED')
  }
  const packet = {
    schemaVersion: DECISION_REPLAY_PACKET_VERSION,
    contracts: { ...CONTRACTS },
    evaluatedAt,
    input: {
      payload: decisionPayload(payload),
      plans: safeClone(Array.isArray(plans) ? plans.slice(0, 3) : []),
    },
  }
  return {
    ...packet,
    packetFingerprint: fingerprint(packet),
  }
}

export function projectDecisionReplayResult(
  advice,
  packetFingerprint = null,
) {
  const actionCode = {
    立即买入: 'BUY',
    加仓: 'ADD',
    持有: 'HOLD',
    减仓: 'REDUCE',
    清仓: 'EXIT',
    观望: 'WAIT',
  }[advice?.action] || 'WAIT'
  const selectedLots = Math.max(
    0,
    Math.trunc(
      finite(advice?.selectedDecisionPlan?.targetPosition?.recommendedLots)
      || 0,
    ),
  )
  const quantityLots = ['BUY', 'ADD'].includes(actionCode)
    ? selectedLots
    : Math.max(0, Math.trunc(finite(advice?.planQty) || 0))
  return {
    schemaVersion: DECISION_REPLAY_RESULT_VERSION,
    packetFingerprint,
    stateFingerprint: advice?.decisionState?.stateFingerprint || null,
    action: actionCode,
    quantityLots,
    prices: {
      buy: finite(advice?.buyPrice),
      add: finite(advice?.addPrice),
      reduce: finite(advice?.reducePrice),
      stop: finite(advice?.stopPrice),
      target: finite(advice?.targetPrice),
      pullbackWatch: finite(advice?.pullbackWatchPrice),
      breakoutWatch: finite(advice?.breakoutWatchPrice),
    },
    blockerCodes: [
      ...new Set(advice?.decisionState?.eligibility?.blockers || []),
    ],
    decisionReason: text(advice?.decisionReason, 80) || null,
    selectedRoute:
      text(advice?.selectedDecisionPlan?.route, 24) || null,
  }
}

export function executeDecisionReplayPacket(packet) {
  validatePacket(packet)
  const advice = buildDecisionAction({
    payload: packet.input.payload,
    plans: packet.input.plans,
    now: packet.evaluatedAt,
  })
  return {
    advice,
    result: projectDecisionReplayResult(
      advice,
      packet.packetFingerprint,
    ),
  }
}
