export const FORMULA_EVIDENCE_SCHEMA_VERSION = 'formula-evidence.v1'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function validationWeight(validation = {}) {
  const state = String(validation.validationState || 'OBSERVE_ONLY')
  const samples = Math.max(0, Number(validation.sampleSize) || 0)
  const expectancy = finite(validation.expectancyPct)
  const profitFactor = finite(validation.profitFactor)
  const stableWindows = Math.max(0, Number(validation.stableWindows) || 0)

  if (
    state === 'VALIDATED'
    && samples >= 100
    && expectancy > 0
    && profitFactor > 1
    && stableWindows >= 2
  ) return 0.15
  if (
    ['BACKTEST_POSITIVE', 'VALIDATED'].includes(state)
    && samples >= 30
    && expectancy > 0
    && profitFactor > 1
  ) return 0.1
  return 0.05
}

export function buildFormulaEvidenceReference(
  decision = {},
  validation = {},
) {
  const positionMode = String(decision.positionMode || 'UNOWNED')
  const action = String(decision.action || 'AVOID')
  const conflicts = []
  const newRisk = (
    positionMode === 'UNOWNED'
    && ['WATCH_BUY', 'BUY_REVIEW'].includes(action)
  )
  // 大盘阻断时会保留研究价格并把动作降级为 AVOID，此时价格合同仍成立，
  // 但它本质仍是买入方向的参考，必须一并纳入风险闸门，禁止靠历史胜率升权。
  const buySideReference = (
    positionMode === 'UNOWNED'
    && decision.priceContractValid === true
  )

  if (decision.dataComplete !== true) conflicts.push('关键数据不完整')
  if (decision.dataFresh !== true) conflicts.push('行情数据已过期')
  if (decision.priceContractValid !== true) {
    conflicts.push('价格合同未通过')
  }
  if (newRisk && !(finite(decision.riskReward) >= 1.8)) {
    conflicts.push('盈亏比不足1.8:1')
  }
  if (buySideReference && decision.marketAllowsRisk !== true) {
    conflicts.push('市场或账户不允许新增风险')
  }

  const hardStop = (
    positionMode === 'HELD'
    && action === 'EXIT'
    && decision.hardStopTriggered === true
    && decision.dataComplete === true
    && decision.dataFresh === true
    && decision.priceContractValid === true
  )
  const effectiveWeight = hardStop
    ? 1
    : conflicts.length ? 0 : validationWeight(validation)

  return {
    schemaVersion: FORMULA_EVIDENCE_SCHEMA_VERSION,
    formulaId: String(decision.formulaId || ''),
    positionMode,
    action,
    primaryPrice: finite(decision.primaryPrice),
    stopPrice: finite(decision.stopPrice),
    targetPrice: finite(decision.targetPrice),
    riskReward: finite(decision.riskReward),
    validationState: String(
      validation.validationState || 'OBSERVE_ONLY',
    ),
    effectiveWeight,
    role: hardStop
      ? 'DETERMINISTIC_RISK_OVERRIDE'
      : 'SECONDARY_PRICE_REFERENCE',
    canUpgradeAction: false,
    canForceRiskReduction: hardStop,
    conflicts,
  }
}
