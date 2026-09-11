import {
  A_SHARE_STANDARD_FEE_POLICY,
  executionPrice,
  tradeFees,
} from './ashareStrategyExecution.js'
import { isExecutableOpportunityScore } from './opportunityScoreContract.js'

export const TRADE_EXPECTANCY_SCHEMA_VERSION = 'trade-expectancy.v1'

const RISK_INCREASING = new Set(['BUY', 'ADD', 'T_BUY_FIRST'])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function positive(value) {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function round(value, digits = 4) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function probability(value) {
  const number = finite(value)
  if (number == null) return null
  const normalized = number > 1 ? number / 100 : number
  return normalized >= 0 && normalized <= 1
    ? normalized
    : null
}

function sellProceeds(price, shares, slippageBps) {
  const fillPrice = executionPrice(price, 'SELL', slippageBps)
  const gross = fillPrice * shares
  const fees = tradeFees('SELL', gross, A_SHARE_STANDARD_FEE_POLICY)
  return {
    fillPrice,
    gross,
    fees: fees.total,
    net: gross - fees.total,
  }
}

function alignedPrice(left, right, tolerancePct) {
  const first = positive(left)
  const second = positive(right)
  if (first == null || second == null) return false
  return Math.abs(first / second - 1) * 100 <= tolerancePct
}

function scoreMatchesPlan(
  opportunityScore,
  { entry, stop, target },
) {
  const contract = opportunityScore?.priceContract
  if (!contract) return false
  return (
    alignedPrice(contract.entryPrice, entry, 1.5)
    && alignedPrice(contract.stopPrice, stop, 2)
    && alignedPrice(contract.targetPrice, target, 2)
  )
}

function modelEstimate(
  opportunityScore,
  quant,
  rewardR,
  prices,
  researchPrior,
) {
  if (
    isExecutableOpportunityScore(opportunityScore)
    && opportunityScore?.serverVerified === true
    && scoreMatchesPlan(opportunityScore, prices)
  ) {
    const pFill = probability(opportunityScore.pFill)
    const pWin = probability(opportunityScore.pWinGivenFill)
    const expectedNetR = finite(opportunityScore.expectedNetR)
    const lowerBound = finite(opportunityScore.netRLowerBound)
    const expectedShortfall = finite(
      opportunityScore.expectedShortfall10,
    )
    if (
      pFill != null
      && pWin != null
      && expectedNetR != null
      && lowerBound != null
    ) {
      return {
        state: 'CALIBRATED',
        source: 'DECISION_MODEL',
        modelVersion:
          String(opportunityScore.modelVersion || '') || null,
        pFill,
        pWinGivenFill: pWin,
        expectedNetRGivenFill: expectedNetR,
        expectedNetRPerCandidate: pFill * expectedNetR,
        netRLowerBound: lowerBound,
        meanConfidenceLowerBound: finite(
          opportunityScore.meanConfidenceLowerBound,
        ),
        lowerBoundPerCandidate: pFill * lowerBound,
        expectedShortfall10R: expectedShortfall,
        sampleCount: Math.max(
          0,
          Math.trunc(
            finite(opportunityScore.calibration?.sampleCount) || 0,
          ),
        ),
        calibrationMethod:
          String(opportunityScore.calibration?.method || '') || null,
      }
    }
  }

  const signal = quant?.highConfSignal
  const targetHitOnly = /future_max_high|触及.*止盈|TARGET_HIT/i.test(
    `${signal?.label || ''} ${signal?.labelRule || ''} ${signal?.probabilityKind || ''}`,
  ) && signal?.probabilityKind !== 'TP_BEFORE_SL'
  const signalAligned = signal?.fired === true
    && !targetHitOnly
    && quant?.shadowOnly !== true
    && quant?.outOfDistribution !== true
    && alignedPrice(signal.buyPrice, prices.entry, 1.5)
    && alignedPrice(signal.stopLoss, prices.stop, 2)
    && alignedPrice(signal.takeProfit, prices.target, 2)
  const pWin = signalAligned
    ? probability(signal.credibility)
    : null
  if (pWin != null && rewardR > 0) {
    return {
      state: 'MODEL_ESTIMATE',
      source: 'QUANT_BARRIER_SIGNAL',
      modelVersion:
        String(
          quant?.selectedModelVersion
          || quant?.modelVersion
          || '',
        ) || null,
      pFill: null,
      pWinGivenFill: pWin,
      expectedNetRGivenFill: pWin * rewardR - (1 - pWin),
      expectedNetRPerCandidate: null,
      netRLowerBound: null,
      lowerBoundPerCandidate: null,
      expectedShortfall10R: null,
      sampleCount: null,
      calibrationMethod: 'QUANT_SIGNAL_CALIBRATION',
    }
  }

  const priorWin = researchPrior?.serverVerified === true
    ? probability(researchPrior.pWinGivenFill)
    : null
  if (priorWin != null && rewardR > 0) {
    const priorFill = probability(researchPrior.pFill)
    const expectedNetR = priorWin * rewardR - (1 - priorWin)
      - Math.max(0, finite(researchPrior.costR) || 0)
    const lowerNetR = finite(researchPrior.lowerNetR)
      ?? expectedNetR - Math.max(
        0.2,
        finite(researchPrior.uncertaintyR) || 0.45,
      )
    return {
      state: 'RESEARCH_ESTIMATE',
      source: 'SERVER_ACTION_POLICY',
      modelVersion:
        String(researchPrior.version || 'adaptive-action-policy.v1'),
      pFill: priorFill,
      pWinGivenFill: priorWin,
      expectedNetRGivenFill: expectedNetR,
      expectedNetRPerCandidate: priorFill == null
        ? null
        : priorFill * expectedNetR,
      netRLowerBound: lowerNetR,
      lowerBoundPerCandidate: null,
      expectedShortfall10R: finite(researchPrior.expectedShortfall10R),
      sampleCount: Math.max(
        0,
        Math.trunc(finite(researchPrior.sampleCount) || 0),
      ),
      calibrationMethod: 'SERVER_RESEARCH_PRIOR',
    }
  }

  return {
    state: 'PLAN_ONLY',
    source: 'PRICE_CONTRACT',
    modelVersion: null,
    pFill: null,
    pWinGivenFill: null,
    expectedNetRGivenFill: null,
    expectedNetRPerCandidate: null,
    netRLowerBound: null,
    lowerBoundPerCandidate: null,
    expectedShortfall10R: null,
    sampleCount: null,
    calibrationMethod: null,
    evidenceGap: targetHitOnly
      ? '量化仅估计窗口内曾触及目标价，未估计止损前盈利概率，不能据此证明本计划正期望'
      : null,
  }
}

function expectancyGate(estimate, breakEvenWinProbability) {
  if (estimate.state === 'CALIBRATED') {
    if (
      estimate.expectedNetRGivenFill <= 0
      || (
        estimate.meanConfidenceLowerBound != null
        && estimate.meanConfidenceLowerBound <= 0
      )
    ) {
      return {
        state: 'NEGATIVE',
        allowsRiskIncrease: false,
        reason:
          `同类历史费后期望${round(estimate.expectedNetRGivenFill, 2)}R，`
          + (estimate.meanConfidenceLowerBound != null
            ? `均值置信下界${round(estimate.meanConfidenceLowerBound, 2)}R，`
            : '')
          + '未证明正期望',
      }
    }
    return {
      state: 'POSITIVE',
      allowsRiskIncrease: true,
      reason:
        `同类历史费后期望${round(estimate.expectedNetRGivenFill, 2)}R，`
        + `单次结果尾部参考${round(estimate.netRLowerBound, 2)}R`,
    }
  }
  const estimated = ['MODEL_ESTIMATE', 'RESEARCH_ESTIMATE']
    .includes(estimate.state)
  if (estimated && estimate.expectedNetRGivenFill <= 0) {
    return {
      state: 'NEGATIVE',
      allowsRiskIncrease: false,
      reason:
        `量化成功概率${round(estimate.pWinGivenFill * 100, 1)}%，`
        + `低于该计划费后盈亏平衡所需的${
          round(breakEvenWinProbability * 100, 1)
        }%`,
    }
  }
  return {
    state: estimated
      ? estimate.state === 'RESEARCH_ESTIMATE'
        ? 'POSITIVE_RESEARCH_ESTIMATE'
        : 'POSITIVE_ESTIMATE'
      : 'UNCALIBRATED',
    allowsRiskIncrease: estimated,
    reason: estimated
      ? `${estimate.state === 'RESEARCH_ESTIMATE' ? '动作先验' : '量化'}成功概率${round(estimate.pWinGivenFill * 100, 1)}%，`
        + `高于费后盈亏平衡所需的${
          round(breakEvenWinProbability * 100, 1)
        }%`
      : `${estimate.evidenceGap || '当前价格合同缺少可靠成功概率，暂不新增仓位'}；费后盈亏平衡至少需要${
          round(breakEvenWinProbability * 100, 1)
        }%胜率`,
  }
}

export function buildTradeExpectancy({
  action,
  referencePrice,
  stopPrice,
  targetPrice,
  quantityLots = 1,
  slippageBps = 5,
  stressExitPrice = null,
  opportunityScore = null,
  quant = null,
  researchPrior = null,
} = {}) {
  const normalizedAction = String(action || '').toUpperCase()
  if (!RISK_INCREASING.has(normalizedAction)) {
    return {
      schemaVersion: TRADE_EXPECTANCY_SCHEMA_VERSION,
      state: 'NOT_APPLICABLE',
      action: normalizedAction || 'WATCH',
      gate: {
        state: 'NOT_APPLICABLE',
        allowsRiskIncrease: true,
        reason: '本次操作不增加风险',
      },
    }
  }

  const entry = positive(referencePrice)
  const stop = positive(stopPrice)
  const target = positive(targetPrice)
  const lots = Math.max(1, Math.trunc(finite(quantityLots) || 1))
  if (!(entry > 0 && stop > 0 && target > entry && entry > stop)) {
    return {
      schemaVersion: TRADE_EXPECTANCY_SCHEMA_VERSION,
      state: 'INVALID_PRICE_CONTRACT',
      action: normalizedAction,
      gate: {
        state: 'INVALID',
        allowsRiskIncrease: false,
        reason: '入场、止损或目标价格关系无效',
      },
    }
  }

  const shares = lots * 100
  const entryFillPrice = executionPrice(entry, 'BUY', slippageBps)
  const entryGross = entryFillPrice * shares
  const entryFees = tradeFees(
    'BUY',
    entryGross,
    A_SHARE_STANDARD_FEE_POLICY,
  )
  const entryCost = entryGross + entryFees.total
  const stopExit = sellProceeds(stop, shares, slippageBps)
  const targetExit = sellProceeds(target, shares, slippageBps)
  const lossAmount = Math.max(0, entryCost - stopExit.net)
  const profitAmount = Math.max(0, targetExit.net - entryCost)
  const rewardR = lossAmount > 0 ? profitAmount / lossAmount : 0
  const breakEvenWinProbability = profitAmount + lossAmount > 0
    ? lossAmount / (profitAmount + lossAmount)
    : 1
  const estimate = modelEstimate(
    opportunityScore,
    quant,
    rewardR,
    { entry, stop, target },
    researchPrior,
  )
  const stressPrice = positive(stressExitPrice)
  const stressExit = stressPrice != null && stressPrice < stop
    ? sellProceeds(stressPrice, shares, slippageBps)
    : null
  const stressLossAmount = stressExit
    ? Math.max(0, entryCost - stressExit.net)
    : null

  return {
    schemaVersion: TRADE_EXPECTANCY_SCHEMA_VERSION,
    state: estimate.state,
    action: normalizedAction,
    source: estimate.source,
    modelVersion: estimate.modelVersion,
    plan: {
      lots,
      shares,
      entryPrice: round(entry),
      stopPrice: round(stop),
      targetPrice: round(target),
      entryFillPrice: round(entryFillPrice),
      stopFillPrice: round(stopExit.fillPrice),
      targetFillPrice: round(targetExit.fillPrice),
      entryFees: round(entryFees.total, 2),
      stopExitFees: round(stopExit.fees, 2),
      targetExitFees: round(targetExit.fees, 2),
      lossAmount: round(lossAmount, 2),
      profitAmount: round(profitAmount, 2),
      netRiskReward: round(rewardR, 3),
      breakEvenWinProbability: round(
        breakEvenWinProbability,
        6,
      ),
    },
    probability: {
      pFill: round(estimate.pFill, 6),
      pWinGivenFill: round(estimate.pWinGivenFill, 6),
      sampleCount: estimate.sampleCount,
      calibrationMethod: estimate.calibrationMethod,
    },
    expectancy: {
      expectedNetRGivenFill: round(
        estimate.expectedNetRGivenFill,
        4,
      ),
      expectedNetRPerCandidate: round(
        estimate.expectedNetRPerCandidate,
        4,
      ),
      netRLowerBound: round(estimate.netRLowerBound, 4),
      lowerBoundKind: 'PREDICTION_P10',
      meanConfidenceLowerBound: round(estimate.meanConfidenceLowerBound, 4),
      lowerBoundPerCandidate: round(
        estimate.lowerBoundPerCandidate,
        4,
      ),
      expectedShortfall10R: round(
        estimate.expectedShortfall10R,
        4,
      ),
    },
    stress: {
      exitPrice: stressExit ? round(stressPrice) : null,
      fillPrice: stressExit ? round(stressExit.fillPrice) : null,
      lossAmount: round(stressLossAmount, 2),
      lossMultiple: stressLossAmount != null && lossAmount > 0
        ? round(stressLossAmount / lossAmount, 2)
        : null,
    },
    gate: expectancyGate(estimate, breakEvenWinProbability),
  }
}
