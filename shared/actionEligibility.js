export const ACTION_ELIGIBILITY_SCHEMA_VERSION =
  'action-eligibility.v1'

export const DECISION_ACTIONS = Object.freeze([
  'WAIT',
  'BUY',
  'ADD',
  'HOLD',
  'HOLD_LOCKED',
  'REDUCE',
  'EXIT',
])

const RISK_INCREASING = new Set(['BUY', 'ADD'])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function integer(value) {
  return Math.max(0, Math.trunc(finite(value) || 0))
}

export function buildActionEligibility({
  position = {},
  quote = {},
  account = {},
  evidence = {},
  model = {},
} = {}) {
  const totalLots = integer(position.totalLots ?? position.holdQty)
  const sellableLots = Math.min(
    totalLots,
    integer(position.sellableLots ?? position.sellableTodayQty),
  )
  const held = totalLots > 0
  const livePrice = finite(quote.price)
  const stopPrice = finite(position.hardStopPrice)
  const hardStop = (
    held
    && quote.live === true
    && livePrice > 0
    && stopPrice > 0
    && livePrice <= stopPrice
  )
  const accountReady = account.complete !== false
  const evidenceReady = evidence.complete !== false
  const modelReady = model.ready !== false
  const canIncreaseRisk = (
    accountReady
    && evidenceReady
    && modelReady
    && account.circuitOpen !== true
    && account.riskIncreaseAllowed !== false
  )
  let actions
  if (!held) {
    actions = ['WAIT', ...(canIncreaseRisk ? ['BUY'] : [])]
  } else if (hardStop) {
    actions = sellableLots > 0 ? ['EXIT'] : ['HOLD_LOCKED']
  } else {
    actions = [
      'HOLD',
      ...(canIncreaseRisk ? ['ADD'] : []),
      ...(sellableLots > 0 ? ['REDUCE'] : ['HOLD_LOCKED']),
      ...(sellableLots >= totalLots ? ['EXIT'] : []),
    ]
  }
  return {
    schemaVersion: ACTION_ELIGIBILITY_SCHEMA_VERSION,
    held,
    hardStop,
    canIncreaseRisk,
    totalLots,
    sellableLots,
    actions: [...new Set(actions)],
    blockers: [
      !accountReady ? 'ACCOUNT_INCOMPLETE' : '',
      !evidenceReady ? 'EVIDENCE_INCOMPLETE' : '',
      !modelReady ? 'MODEL_UNAVAILABLE' : '',
      account.circuitOpen === true ? 'ACCOUNT_CIRCUIT_OPEN' : '',
      account.riskIncreaseAllowed === false
        ? 'RISK_INCREASE_DISABLED'
        : '',
      held && sellableLots === 0 ? 'T1_LOCKED' : '',
    ].filter(Boolean),
  }
}

export function actionIsEligible(eligibility, action) {
  return (
    eligibility?.schemaVersion === ACTION_ELIGIBILITY_SCHEMA_VERSION
    && eligibility.actions?.includes(String(action || '').toUpperCase())
  )
}

export function isRiskIncreasingAction(action) {
  return RISK_INCREASING.has(String(action || '').toUpperCase())
}
