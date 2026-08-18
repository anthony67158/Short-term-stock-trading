import {
  normalizePortfolioAnalysis,
} from '../../shared/portfolioAnalysis.js'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function near(left, right, tolerance = 0.2) {
  const a = finite(left)
  const b = finite(right)
  return a != null && b != null && Math.abs(a - b) <= tolerance
}

function check(
  id,
  dimension,
  passed,
  {
    hard = false,
    message = '',
    details = null,
    code,
  } = {},
) {
  return {
    id,
    code,
    dimension,
    passed: passed === true,
    hard,
    message,
    details,
  }
}

export async function runPortfolioHarnessCase(testCase) {
  const input = testCase.input || {}
  const expect = testCase.expect || {}
  const output = normalizePortfolioAnalysis(
    input.modelOutput || {},
    {
      distribution: input.distribution || {},
      allowedEvidenceIds: input.allowedEvidenceIds || [],
      allowedHoldingCodes: input.allowedHoldingCodes || [],
      allowedRecommendationCodes:
        input.allowedRecommendationCodes || [],
      recommendationCatalog: input.recommendationCatalog || {},
    },
  )
  const plan = output.executionPlan || {}
  const orders = Array.isArray(plan.orders) ? plan.orders : []
  const allowedCodes = new Set([
    ...(input.allowedHoldingCodes || []).map(String),
    ...(input.allowedRecommendationCodes || []).map(String),
  ])
  const allowedEvidence = new Set(
    (input.allowedEvidenceIds || []).map(String),
  )
  const orderCodes = new Set(orders.map((order) => order.code))
  const unknownCodes = orders
    .map((order) => order.code)
    .filter((code) => !allowedCodes.has(String(code)))
  const unknownEvidence = orders.flatMap((order) =>
    (order.evidenceIds || []).filter(
      (evidenceId) => !allowedEvidence.has(String(evidenceId)),
    )
  )
  const t1Violations = orders.filter((order) =>
    ['reduce', 'exit'].includes(order.action)
    && Number(order.estimatedLots) > Number(order.sellableLots)
  )
  const invalidNumbers = orders.filter((order) =>
    [
      order.estimatedLots,
      order.estimatedAmount,
      order.referencePrice,
      order.projectedWeightPct,
    ].some((value) => finite(value) == null || Number(value) < 0)
  )
  const expectedPosition = finite(input.distribution?.positionPct) ?? 0
  const totalAssets = finite(input.distribution?.totalAssets) ?? 0
  const computedPosition = totalAssets > 0
    ? expectedPosition
      + (
        (finite(plan.estimatedBuyAmount) || 0)
        - (finite(plan.estimatedSellAmount) || 0)
      ) / totalAssets * 100
    : 0
  const conceptTotal = (output.conceptActions || []).reduce(
    (sum, item) =>
      sum + (finite(item.executableTargetWeightPct) || 0),
    0,
  )
  const missingRequired = (expect.requiredOrderCodes || [])
    .map(String)
    .filter((code) => !orderCodes.has(code))
  const forbiddenPresent = (expect.forbiddenOrderCodes || [])
    .map(String)
    .filter((code) => orderCodes.has(code))
  const checks = [
    check(
      'execution-plan-contract',
      'contract',
      !!plan && Array.isArray(plan.orders) && !!output.quality,
      {
        hard: true,
        code: 'EXECUTION_PLAN_CONTRACT_INVALID',
        message: '执行单契约缺失',
      },
    ),
    check(
      'finite-output-numbers',
      'contract',
      invalidNumbers.length === 0,
      {
        hard: true,
        code: 'NON_FINITE_OUTPUT',
        message: '执行单包含无效数值',
        details: invalidNumbers.map((order) => order.code),
      },
    ),
    check(
      'stock-code-whitelist',
      'groundedness',
      unknownCodes.length === 0,
      {
        hard: true,
        code: 'STOCK_CODE_NOT_ALLOWED',
        message: '执行单出现白名单外股票',
        details: unknownCodes,
      },
    ),
    check(
      'evidence-whitelist',
      'groundedness',
      unknownEvidence.length === 0,
      {
        hard: true,
        code: 'EVIDENCE_NOT_ALLOWED',
        message: '执行单引用未知证据',
        details: unknownEvidence,
      },
    ),
    check(
      'required-orders',
      'groundedness',
      missingRequired.length === 0,
      {
        hard: true,
        code: 'EXPECTED_ORDER_MISSING',
        message: '期望执行股票未进入执行单',
        details: missingRequired,
      },
    ),
    check(
      'forbidden-orders',
      'groundedness',
      forbiddenPresent.length === 0,
      {
        hard: true,
        code: 'FORBIDDEN_ORDER_PRESENT',
        message: '禁止股票进入执行单',
        details: forbiddenPresent,
      },
    ),
    check(
      't1-sell-limit',
      'feasibility',
      t1Violations.length <= Number(expect.maxT1Violations || 0),
      {
        hard: true,
        code: 'T1_SELL_LIMIT_EXCEEDED',
        message: '卖出手数超过今日可卖量',
        details: t1Violations.map((order) => order.code),
      },
    ),
    check(
      'buy-budget',
      'feasibility',
      Number(plan.estimatedBuyAmount || 0)
        <= Number(plan.buyBudget || 0) + 0.01,
      {
        hard: true,
        code: 'BUY_BUDGET_EXCEEDED',
        message: '买入金额超过服务端预算',
      },
    ),
    check(
      'executable-lots',
      'feasibility',
      orders.every((order) => Number(order.estimatedLots) > 0),
      {
        message: '存在不足一手或无法执行的动作',
      },
    ),
    check(
      'actionable-fields',
      'actionability',
      orders.length > 0 && orders.every((order) =>
        Number(order.referencePrice) > 0
        && Number(order.estimatedAmount) > 0
        && !!order.invalidation
      ),
      {
        message: '执行动作缺少手数、金额、价格或失效条件',
      },
    ),
    check(
      'quality-threshold',
      'actionability',
      Number(output.quality?.score || 0) >= 75,
      {
        message: '生产执行单完整度低于75分',
        details: output.quality?.missing || [],
      },
    ),
    check(
      'position-conservation',
      'consistency',
      near(plan.projectedPositionPct, computedPosition),
      {
        hard: true,
        code: 'POSITION_NOT_CONSERVED',
        message: '执行后总仓位与买卖金额不守恒',
        details: {
          projected: plan.projectedPositionPct,
          computed: +computedPosition.toFixed(2),
        },
      },
    ),
    check(
      'concept-position-consistency',
      'consistency',
      near(conceptTotal, plan.projectedPositionPct),
      {
        message: '概念执行后权重合计与总仓位不一致',
        details: {
          conceptTotal: +conceptTotal.toFixed(2),
          projectedPositionPct: plan.projectedPositionPct,
        },
      },
    ),
  ]
  return {
    output,
    checks,
    metrics: {
      orderCount: orders.length,
      t1ViolationCount: t1Violations.length,
      unknownCodeCount: unknownCodes.length,
      qualityScore: output.quality?.score || 0,
    },
  }
}
