export const CURRENT_STRATEGY_EVALUATION = Object.freeze({
  schemaVersion: 'strategy-evaluation.v1',
  strategyId: 'market-quant-resonance',
  specVersion: 'strategy.15im9g7',
  evaluatedAt: '2026-08-13',
  decision: 'reject',
  folds: 4,
  positiveFolds: 2,
  compoundedReturn: -0.011909,
  worstFoldReturn: -0.096691,
  maximumDrawdown: -0.123783,
  benchmarks: {
    CSI300: {
      positiveExcessFolds: 1,
      compoundedExcessReturn: -0.018186,
    },
    CSI1000: {
      positiveExcessFolds: 2,
      compoundedExcessReturn: 0.001037,
    },
  },
  source: 'docs/Phase2完整股票池WalkForward报告.md',
})

const THRESHOLDS = Object.freeze({
  minimumFolds: 6,
  minimumPositiveFoldRate: 0.67,
  maximumDrawdown: 0.1,
  minimumRealExecutions: 30,
  minimumPosteriorWinRate: 55,
  minimumProfitFactor: 1.2,
  minimumCouncilSamples: 20,
  minimumCouncilConsensusRate: 0.7,
  minimumCouncilHardGatePassRate: 0.7,
})

function rounded(value, digits = 2) {
  const scale = 10 ** digits
  return Math.round((Number(value) || 0) * scale) / scale
}

function blocker(code, message) {
  return { code, message }
}

function councilMetrics(records) {
  const valid = (Array.isArray(records) ? records : []).filter(
    (record) => record?.schemaVersion === 'advisor-council-shadow.v1',
  )
  const consensus = valid.filter(
    (record) => record?.compiled?.consensusReached === true,
  ).length
  const hardGatePassed = valid.filter(
    (record) => record?.compiled?.hardGatePassed === true,
  ).length
  return {
    samples: valid.length,
    consensusRate: valid.length
      ? rounded(consensus / valid.length * 100, 1)
      : 0,
    hardGatePassRate: valid.length
      ? rounded(hardGatePassed / valid.length * 100, 1)
      : 0,
  }
}

export function buildStrategyPromotionGate({
  strategySpec = null,
  evaluation = CURRENT_STRATEGY_EVALUATION,
  realOutcomeLearning = {},
  councilRecords = [],
  humanApproval = null,
} = {}) {
  const blocks = []
  const targetStrategyId = strategySpec?.strategyId
    || evaluation?.strategyId
    || null
  const targetSpecVersion = strategySpec?.specVersion
    || evaluation?.specVersion
    || null
  const evaluationMatches = !!(
    evaluation?.specVersion
    && targetSpecVersion
    && evaluation.specVersion === targetSpecVersion
  )
  if (!evaluationMatches) {
    blocks.push(blocker(
      'SPEC_VERSION_MISMATCH',
      '样本外评估版本与待晋级策略版本不一致',
    ))
  }
  const folds = Math.max(0, Number(evaluation?.folds) || 0)
  const positiveFolds = Math.max(
    0,
    Number(evaluation?.positiveFolds) || 0,
  )
  const requiredPositive = Math.ceil(
    folds * THRESHOLDS.minimumPositiveFoldRate,
  )
  const benchmarks = evaluation?.benchmarks || {}
  if (evaluation?.decision !== 'promote') {
    blocks.push(blocker(
      'OFFLINE_REJECTED',
      '嵌套Walk-forward结论未达到晋级标准',
    ))
  }
  if (folds < THRESHOLDS.minimumFolds) {
    blocks.push(blocker('INSUFFICIENT_OUTER_FOLDS', '外层测试窗口不足'))
  }
  if (positiveFolds < requiredPositive) {
    blocks.push(blocker(
      'UNSTABLE_FOLD_RETURNS',
      `正收益fold仅${positiveFolds}/${folds}`,
    ))
  }
  if (
    Math.abs(Math.min(0, Number(evaluation?.maximumDrawdown) || 0))
    > THRESHOLDS.maximumDrawdown
  ) {
    blocks.push(blocker('DRAWDOWN_TOO_HIGH', '最大回撤超过10%'))
  }
  for (const name of ['CSI300', 'CSI1000']) {
    const metric = benchmarks[name] || {}
    if (
      Number(metric.compoundedExcessReturn) <= 0
      || Number(metric.positiveExcessFolds) < requiredPositive
    ) {
      blocks.push(blocker(
        `BENCHMARK_${name}_FAILED`,
        `${name}费后超额收益不稳定`,
      ))
    }
  }

  const live = realOutcomeLearning?.overall || {}
  if (Number(live.samples) < THRESHOLDS.minimumRealExecutions) {
    blocks.push(blocker(
      'INSUFFICIENT_REAL_EXECUTIONS',
      `真实费后成交样本不足${THRESHOLDS.minimumRealExecutions}笔`,
    ))
  } else {
    if (Number(live.posteriorWinRate) < THRESHOLDS.minimumPosteriorWinRate) {
      blocks.push(blocker('REAL_WIN_RATE_TOO_LOW', '真实成交收缩胜率不足55%'))
    }
    if (
      live.profitFactor == null
      || Number(live.profitFactor) < THRESHOLDS.minimumProfitFactor
    ) {
      blocks.push(blocker('REAL_PROFIT_FACTOR_TOO_LOW', '真实成交Profit Factor不足1.2'))
    }
    if (Number(live.expectancy) <= 0) {
      blocks.push(blocker('REAL_EXPECTANCY_NOT_POSITIVE', '真实成交费后期望不为正'))
    }
  }

  const council = councilMetrics(councilRecords)
  if (council.samples < THRESHOLDS.minimumCouncilSamples) {
    blocks.push(blocker(
      'INSUFFICIENT_COUNCIL_SHADOW',
      `委员会影子样本不足${THRESHOLDS.minimumCouncilSamples}条`,
    ))
  } else {
    if (
      council.consensusRate
      < THRESHOLDS.minimumCouncilConsensusRate * 100
    ) {
      blocks.push(blocker('COUNCIL_CONSENSUS_TOO_LOW', '委员会共识率不足70%'))
    }
    if (
      council.hardGatePassRate
      < THRESHOLDS.minimumCouncilHardGatePassRate * 100
    ) {
      blocks.push(blocker('COUNCIL_GATE_PASS_TOO_LOW', '委员会硬闸门通过率不足70%'))
    }
  }

  const approved = !!(
    humanApproval
    && humanApproval.specVersion === targetSpecVersion
    && humanApproval.approvedBy
    && Number(humanApproval.approvedAt) > 0
  )
  if (!approved) {
    blocks.push(blocker(
      'HUMAN_APPROVAL_REQUIRED',
      '需要人工批准相同策略版本',
    ))
  }
  return {
    schemaVersion: 'strategy-promotion-gate.v1',
    strategyId: targetStrategyId,
    specVersion: targetSpecVersion,
    evaluationSpecVersion: evaluation?.specVersion || null,
    shadowEligible: !!evaluation?.specVersion && evaluationMatches,
    productionEligible: blocks.length === 0,
    decision: blocks.length === 0 ? 'promote' : 'reject',
    thresholds: THRESHOLDS,
    metrics: {
      offline: {
        folds,
        positiveFolds,
        compoundedReturn: Number(evaluation?.compoundedReturn) || 0,
        maximumDrawdown: Number(evaluation?.maximumDrawdown) || 0,
        benchmarks,
      },
      real: {
        samples: Number(live.samples) || 0,
        posteriorWinRate: live.posteriorWinRate ?? null,
        profitFactor: live.profitFactor ?? null,
        expectancy: live.expectancy ?? null,
      },
      council,
      humanApproved: approved,
    },
    blockers: blocks,
  }
}
