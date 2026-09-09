import {
  isExecutableOpportunityScore,
} from './opportunityScoreContract.js'
import {
  scoreOpportunityPlaybooks,
} from './opportunityPlaybooks.js'

export const ADAPTIVE_OPPORTUNITY_VERSION = 'adaptive-opportunity.v1'

const HARD_BLOCKER_PATTERNS = [
  /行情.*(?:不完整|过期|不可用)/,
  /数据.*(?:不完整|过期)/,
  /结果已过期/,
  /观察时段已结束/,
  /手动试算/,
  /价格合同.*(?:不完整|无效)/,
  /买卖价格合同不完整/,
  /止损.*(?:无效|缺少)/,
  /不可卖|T\+1/,
  /现金.*不足/,
  /风险预算.*不足/,
  /流动性.*(?:不足|无法退出)/,
  /费后期望.*(?:为负|不大于0)/,
  /重大负面|立案|退市|风险公告|停牌/,
]

const SOFT_BLOCKER_PATTERNS = [
  /市场/,
  /板块/,
  /主线/,
  /公式/,
  /均线/,
  /涨幅/,
  /换手/,
  /成交额/,
  /量比/,
  /VWAP/,
  /资金/,
  /追高/,
  /位置/,
  /样本/,
]

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 3) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function unique(values = []) {
  return [...new Set(
    values.map((value) => String(value || '').trim()).filter(Boolean),
  )]
}

function blockerKind(value) {
  const text = String(value || '')
  if (HARD_BLOCKER_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'HARD'
  }
  if (SOFT_BLOCKER_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'SOFT'
  }
  return 'SOFT'
}

function pricePlan(candidate = {}) {
  const entry = finite(candidate.entryPlan?.price ?? candidate.primaryPrice)
  const stop = finite(
    candidate.exitPlan?.hardStopPrice
    ?? candidate.stopPrice,
  )
  const target = finite(
    candidate.exitPlan?.takeProfitPrice
    ?? candidate.exitPlan?.targetPrice
    ?? candidate.targetPrice,
  )
  const risk = entry != null && stop != null ? entry - stop : null
  const reward = entry != null && target != null ? target - entry : null
  const riskReward = risk > 0 && reward > 0
    ? reward / risk
    : finite(candidate.riskReward)
  return {
    entry,
    stop,
    target,
    riskReward,
    valid: entry > 0 && stop > 0 && target > entry && stop < entry,
  }
}

function executionProbability(candidate, plan, playbookScore) {
  const supplied = finite(candidate.opportunityScore?.pFill)
  if (supplied != null) return clamp(supplied, 0.02, 0.98)
  const current = finite(candidate.quote?.price)
  const distance = current > 0 && plan.entry > 0
    ? Math.abs(plan.entry / current - 1) * 100
    : 2
  const triggerType = String(
    candidate.entryPlan?.type || candidate.priceType || '',
  )
  const base = /IMMEDIATE/.test(triggerType)
    ? 0.9
    : /BREAKOUT/.test(triggerType)
      ? 0.58
      : 0.68
  return clamp(
    base
      - Math.min(0.35, distance * 0.055)
      + (playbookScore - 60) / 500,
    0.15,
    0.94,
  )
}

function scoreMatchesPlan(score, plan) {
  const contract = score?.priceContract
  if (!contract) return true
  return [
    [contract.entryPrice, plan.entry],
    [contract.stopPrice, plan.stop],
    [contract.targetPrice, plan.target],
  ].every(([left, right]) => {
    const expected = finite(left)
    const actual = finite(right)
    return expected > 0
      && actual > 0
      && Math.abs(expected / actual - 1) <= 0.02
  })
}

function researchEstimate(candidate, plan, playbookScore) {
  const score = candidate.opportunityScore || {}
  const suppliedWin = finite(score.pWinGivenFill)
  const suppliedNetR = finite(score.expectedNetR)
  const suppliedLower = finite(
    score.meanConfidenceLowerBound
    ?? score.netRLowerBound,
  )
  if (
    suppliedWin != null
    && suppliedNetR != null
    && scoreMatchesPlan(score, plan)
  ) {
    return {
      source: isExecutableOpportunityScore(score)
        ? 'CALIBRATED_MODEL'
        : 'SHADOW_MODEL',
      pWinGivenFill: clamp(suppliedWin, 0.02, 0.98),
      expectedNetR: suppliedNetR,
      lowerNetR: suppliedLower,
      productionReady: isExecutableOpportunityScore(score),
      sampleCount: Math.max(
        0,
        Math.trunc(finite(score.calibration?.sampleCount) || 0),
      ),
    }
  }
  const probability = clamp(
    0.36 + playbookScore / 260,
    0.4,
    0.72,
  )
  const costR = plan.riskReward > 0
    ? clamp(0.055 / Math.max(0.5, plan.riskReward), 0.025, 0.11)
    : 0.08
  const expectedNetR = probability * plan.riskReward
    - (1 - probability)
    - costR
  return {
    source: 'RESEARCH_PRIOR',
    pWinGivenFill: probability,
    expectedNetR,
    lowerNetR: expectedNetR - 0.55,
    productionReady: false,
    sampleCount: 0,
  }
}

function tierFor({
  plan,
  estimate,
  playbook,
  hardBlockers,
  cautions,
  marketContext,
}) {
  if (!plan.valid || hardBlockers.length) return 'AVOID'
  if (!(estimate.expectedNetR > 0)) return 'AVOID'
  const needsFreshConfirmation = cautions.some((item) =>
    /重新确认|样本|校准|待核验|数据暂缺/.test(item)
  )
  if (
    estimate.lowerNetR > 0
    && playbook.score >= 58
    && !needsFreshConfirmation
    && estimate.productionReady
  ) return 'ATTACK'
  if (
    playbook.score >= 66
    && estimate.expectedNetR >= 0.12
    && (
      marketContext.hardRisk !== true
      || ['CATALYST', 'PANIC_REVERSAL', 'LEADER_PULLBACK']
        .includes(playbook.key)
    )
  ) return 'PROBE'
  return 'WATCH'
}

function riskBudget({
  tier,
  plan,
  playbook,
  estimate,
  marketContext,
}) {
  if (!['ATTACK', 'PROBE'].includes(tier)) {
    return { riskPct: 0, maxPositionPct: 0 }
  }
  const base = finite(marketContext.baseRiskPct) ?? 0.35
  const edgeFactor = clamp(playbook.score / 70, 0.65, 1.25)
  const confidenceFactor = estimate.productionReady
    ? 1
    : estimate.source === 'SHADOW_MODEL' ? 0.65 : 0.45
  const tierFactor = tier === 'ATTACK' ? 1 : 0.55
  const riskPct = clamp(
    base * edgeFactor * confidenceFactor * tierFactor,
    0.08,
    tier === 'ATTACK' ? 0.8 : 0.28,
  )
  const stopDistancePct = (
    plan.entry > 0 && plan.stop > 0
      ? (plan.entry - plan.stop) / plan.entry * 100
      : null
  )
  const maxPositionPct = stopDistancePct > 0
    ? clamp(riskPct / stopDistancePct * 100, 1, tier === 'ATTACK' ? 20 : 6)
    : 0
  return {
    riskPct: rounded(riskPct, 3),
    maxPositionPct: rounded(maxPositionPct, 1),
    stopDistancePct: rounded(stopDistancePct, 2),
  }
}

export function evaluateAdaptiveOpportunity(
  candidate = {},
  marketContext = {},
) {
  const playbooks = scoreOpportunityPlaybooks(candidate, marketContext)
  const plan = pricePlan(candidate)
  const originalBlockers = unique(candidate.blockers || [])
  const hardBlockers = originalBlockers.filter(
    (item) => blockerKind(item) === 'HARD',
  )
  const cautions = originalBlockers.filter(
    (item) => blockerKind(item) === 'SOFT',
  )
  if (!plan.valid) hardBlockers.push('买卖价格合同不完整')
  const estimate = plan.valid
    ? researchEstimate(
        candidate,
        plan,
        playbooks.selected?.score || 0,
      )
    : {
        source: 'UNAVAILABLE',
        pWinGivenFill: null,
        expectedNetR: null,
        lowerNetR: null,
        productionReady: false,
        sampleCount: 0,
      }
  if (
    estimate.source === 'CALIBRATED_MODEL'
    && !(estimate.expectedNetR > 0)
  ) hardBlockers.push('校准后的费后期望不大于0')
  const tier = tierFor({
    plan,
    estimate,
    playbook: playbooks.selected,
    hardBlockers,
    cautions,
    marketContext,
  })
  const pFill = plan.valid
    ? executionProbability(
        candidate,
        plan,
        playbooks.selected?.score || 0,
      )
    : null
  const utility = pFill == null || estimate.expectedNetR == null
    ? null
    : (
        pFill * estimate.expectedNetR
        + Math.min(0, estimate.lowerNetR || 0) * 0.35
      )
  return {
    schemaVersion: ADAPTIVE_OPPORTUNITY_VERSION,
    tier,
    action: tier === 'ATTACK'
      ? 'EXECUTE'
      : tier === 'PROBE'
        ? 'PROBE'
        : tier === 'WATCH' ? 'WATCH' : 'AVOID',
    actionLabel: tier === 'ATTACK'
      ? '优先执行'
      : tier === 'PROBE'
        ? '小仓验证'
        : tier === 'WATCH' ? '等待优势扩大' : '放弃',
    playbook: playbooks.selected,
    alternatives: playbooks.alternatives,
    factors: playbooks.factors,
    marketOpportunityFactor:
      rounded(marketContext.opportunityFactor, 3),
    estimate: {
      source: estimate.source,
      pFill: rounded(pFill, 4),
      pWinGivenFill: rounded(estimate.pWinGivenFill, 4),
      expectedNetR: rounded(estimate.expectedNetR, 3),
      lowerNetR: rounded(estimate.lowerNetR, 3),
      sampleCount: estimate.sampleCount,
      productionReady: estimate.productionReady,
    },
    risk: riskBudget({
      tier,
      plan,
      playbook: playbooks.selected,
      estimate,
      marketContext,
    }),
    utility: rounded(utility, 4),
    hardBlockers: unique(hardBlockers),
    cautions,
  }
}

export function rankAdaptiveOpportunities(
  candidates = [],
  marketContext = {},
) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const adaptive = evaluateAdaptiveOpportunity(candidate, marketContext)
      const state = adaptive.tier === 'ATTACK'
        ? 'READY'
        : adaptive.tier === 'AVOID'
          ? 'AVOID'
          : 'WAIT_TRIGGER'
      return {
        ...candidate,
        state,
        stateLabel: adaptive.actionLabel,
        blockers: adaptive.hardBlockers,
        cautions: adaptive.cautions,
        entryPlan: candidate.entryPlan
          ? {
              ...candidate.entryPlan,
              maxPositionPct: adaptive.risk.maxPositionPct,
            }
          : candidate.entryPlan,
        adaptive,
      }
    })
    .sort((left, right) =>
      ({ READY: 0, WAIT_TRIGGER: 1, AVOID: 2 }[left.state] ?? 3)
        - ({ READY: 0, WAIT_TRIGGER: 1, AVOID: 2 }[right.state] ?? 3)
      || Number(right.adaptive?.utility ?? -Infinity)
        - Number(left.adaptive?.utility ?? -Infinity)
      || Number(right.adaptive?.playbook?.score || 0)
        - Number(left.adaptive?.playbook?.score || 0)
      || String(left.code || '').localeCompare(String(right.code || '')),
    )
}
