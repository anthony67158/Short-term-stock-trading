import {
  executionPrice,
  tradeFees,
} from './ashareStrategyExecution.js'

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, finite(value)))
}

function rounded(value, digits = 1) {
  return +finite(value).toFixed(digits)
}

function text(value, maximum = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function stringList(value, maximum = 8, itemLength = 180) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item, itemLength))
    .filter(Boolean)
    .slice(0, maximum)
}

function evidenceIds(value, allowed) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => text(item, 24))
      .filter((item) => allowed.has(item)),
  )].slice(0, 8)
}

export function sanitizePortfolioAnalysisRequest(body = {}) {
  return {
    deepMode: body?.deepMode === true,
    refresh: body?.refresh === true || body?.refresh === 1,
  }
}

export function selectPortfolioCandidates(
  activeConcepts = [],
  distribution = {},
  limit = 4,
) {
  const heldCodes = new Set(
    (distribution.stocks || []).map((stock) => String(stock.code)),
  )
  const heldConcepts = new Set(
    (distribution.groups || []).map((group) => String(group.name)),
  )
  const seenCodes = new Set()
  const seenConcepts = new Set()
  return (Array.isArray(activeConcepts) ? activeConcepts : [])
    .filter((item) => {
      const code = String(item?.leadCode || '')
      const concept = text(item?.name, 50)
      if (
        !/^\d{6}$/.test(code)
        || !item?.leadName
        || !concept
        || finite(item?.pct) <= 0
        || finite(item?.mainInflowYi) <= 0
        || heldCodes.has(code)
        || heldConcepts.has(concept)
        || seenCodes.has(code)
        || seenConcepts.has(concept)
      ) return false
      seenCodes.add(code)
      seenConcepts.add(concept)
      return true
    })
    .map((item) => ({
      code: String(item.leadCode),
      name: text(item.leadName, 40),
      concept: text(item.name, 50),
      pct: rounded(item.pct),
      mainInflowYi: rounded(item.mainInflowYi),
      mainRatio: rounded(item.mainRatio),
      leadPct: rounded(item.leadPct),
    }))
    .slice(0, Math.max(0, Math.min(8, Math.trunc(limit) || 4)))
}

export function buildPortfolioDecisionNodes(
  distribution = {},
  market = {},
) {
  const positionPct = rounded(distribution.positionPct)
  const topConcept = distribution.groups?.[0]
  const topCategory = (distribution.categories || [])
    .slice()
    .sort(
      (left, right) =>
        finite(right?.accountWeightPct)
        - finite(left?.accountWeightPct),
    )[0]
  return [
    {
      key: 'position',
      title: '总仓位预算',
      status: positionPct >= 85
        ? 'risk'
        : positionPct >= 60 ? 'watch' : 'ok',
      conclusion: `当前总仓位${positionPct.toFixed(1)}%，现金预留${rounded(distribution.cashReservePct).toFixed(1)}%。`,
    },
    {
      key: 'concentration',
      title: '概念集中度',
      status: finite(topConcept?.accountWeightPct) >= 35
        ? 'risk'
        : finite(topConcept?.accountWeightPct) >= 20 ? 'watch' : 'ok',
      conclusion: topConcept
        ? `${text(topConcept.name, 40)}为最大概念暴露，占总资产${rounded(topConcept.accountWeightPct).toFixed(1)}%。`
        : '暂无可识别的概念暴露。',
    },
    {
      key: 'category',
      title: '仓位类别结构',
      status: finite(topCategory?.accountWeightPct) >= 60
        ? 'watch'
        : 'ok',
      conclusion: topCategory
        ? `${text(topCategory.name, 20)}占总资产${rounded(topCategory.accountWeightPct).toFixed(1)}%，共${Math.max(0, Math.trunc(finite(topCategory.stockCount)))}只。`
        : '暂无仓位类别数据。',
    },
    {
      key: 'market',
      title: '市场环境约束',
      status: market?.regime === 'defensive'
        ? 'risk'
        : market?.regime === 'balanced' ? 'watch' : 'ok',
      conclusion: text(
        market?.note
        || market?.summary
        || '市场环境数据不足，暂按中性风险预算处理。',
        180,
      ),
    },
  ]
}

function normalizeCategoryTargets(value = {}) {
  return {
    corePct: rounded(clamp(value.corePct)),
    standardPct: rounded(clamp(value.standardPct)),
    satellitePct: rounded(clamp(value.satellitePct)),
  }
}

function normalizeAdjustments(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      target: text(item?.target, 50),
      action: ['increase', 'reduce', 'hold'].includes(item?.action)
        ? item.action
        : 'hold',
      changePct: rounded(clamp(item?.changePct)),
      reason: text(item?.reason, 240),
    }))
    .filter((item) => item.target && item.reason)
    .slice(0, 10)
}

function positive(value) {
  return Math.max(0, finite(value))
}

function priority(value, fallback) {
  return Math.max(
    1,
    Math.min(99, Math.trunc(finite(value, fallback))),
  )
}

function normalizeConceptActions(
  value,
  {
    distribution,
    recommendationCatalog,
    allowedEvidence,
    targetPositionPct,
  },
) {
  const current = new Map(
    (distribution.groups || []).map((group) => [
      group.name,
      finite(group.accountWeightPct),
    ]),
  )
  const allowed = new Set([
    ...current.keys(),
    ...Object.values(recommendationCatalog)
      .map((item) => text(item?.concept, 50))
      .filter(Boolean),
  ])
  const rows = (Array.isArray(value) ? value : [])
    .map((item) => {
      const concept = text(item?.concept, 50)
      const currentWeightPct = rounded(current.get(concept) || 0)
      const targetWeightPct = rounded(clamp(item?.targetWeightPct))
      const deltaWeightPct = rounded(
        targetWeightPct - currentWeightPct,
      )
      return {
        concept,
        action: deltaWeightPct > 0.2
          ? 'increase'
          : deltaWeightPct < -0.2 ? 'reduce' : 'hold',
        currentWeightPct,
        targetWeightPct,
        deltaWeightPct,
        reason: text(item?.reason, 260),
        evidenceIds: evidenceIds(
          item?.evidenceIds,
          allowedEvidence,
        ),
      }
    })
    .filter((item) =>
      allowed.has(item.concept)
      && item.reason
      && item.evidenceIds.length > 0
    )
    .slice(0, 12)
  const total = rows.reduce(
    (sum, item) => sum + item.targetWeightPct,
    0,
  )
  if (total <= targetPositionPct || total <= 0) return rows
  return rows.map((item) => {
    const targetWeightPct = rounded(
      item.targetWeightPct * targetPositionPct / total,
    )
    return {
      ...item,
      targetWeightPct,
      deltaWeightPct: rounded(
        targetWeightPct - item.currentWeightPct,
      ),
    }
  })
}

function normalizeScenarioPlan(value) {
  const allowed = new Set(['strong', 'balanced', 'weak'])
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      regime: allowed.has(item?.regime)
        ? item.regime
        : 'balanced',
      signal: text(item?.signal, 240),
      targetPositionPct: rounded(
        clamp(item?.targetPositionPct),
      ),
      actions: stringList(item?.actions, 5, 180),
    }))
    .filter((item) => item.signal && item.actions.length > 0)
    .slice(0, 3)
}

function estimateExecution(side, referencePrice, lots, slippageBps = 5) {
  if (!(referencePrice > 0 && lots > 0)) {
    return {
      estimatedFillPrice: referencePrice > 0 ? rounded(referencePrice, 3) : 0,
      estimatedFees: 0,
      estimatedCashImpact: 0,
    }
  }
  const fillPrice = executionPrice(referencePrice, side, slippageBps)
  const gross = fillPrice * lots * 100
  const fees = tradeFees(side, gross)
  return {
    estimatedFillPrice: rounded(fillPrice, 3),
    estimatedFees: rounded(fees.total, 2),
    estimatedCashImpact: rounded(
      side === 'BUY' ? gross + fees.total : gross - fees.total,
      2,
    ),
  }
}

function affordableBuyLots(referencePrice, desiredLots, cash, slippageBps = 5) {
  let lots = Math.max(0, Math.trunc(desiredLots))
  while (lots > 0) {
    const estimate = estimateExecution(
      'BUY',
      referencePrice,
      lots,
      slippageBps,
    )
    if (estimate.estimatedCashImpact <= cash) {
      return { lots, estimate }
    }
    lots -= 1
  }
  return {
    lots: 0,
    estimate: estimateExecution('BUY', referencePrice, 0, slippageBps),
  }
}

function buildExecutionPlan({
  distribution,
  targetPositionPct,
  stockActions,
  recommendedStocks,
  executionSummary,
  conceptActions,
  scenarioPlan,
}) {
  const totalAssets = positive(distribution.totalAssets)
  const sellOrders = stockActions
    .filter((item) => ['reduce', 'exit'].includes(item.action))
    .map((item) => {
      const currentWeightPct = rounded(item.currentWeightPct)
      const targetWeightPct = item.action === 'exit'
        ? 0
        : Math.min(
            currentWeightPct,
            rounded(clamp(item.targetWeightPct)),
          )
      const deltaWeightPct = rounded(
        targetWeightPct - currentWeightPct,
      )
      const referencePrice = positive(
        item.triggerPrice || item.price,
      )
      const desiredAmount = positive(
        -deltaWeightPct / 100 * totalAssets,
      )
      const desiredLots = referencePrice > 0
        ? Math.floor(desiredAmount / (referencePrice * 100) + 1e-9)
        : 0
      const sellableLots = Math.min(
        Math.floor(positive(item.qty)),
        Math.floor(positive(item.sellableQty ?? item.qty)),
      )
      const estimatedLots = Math.min(desiredLots, sellableLots)
      const estimatedAmount = rounded(
        estimatedLots * referencePrice * 100,
      )
      const execution = estimateExecution(
        'SELL',
        referencePrice,
        estimatedLots,
      )
      const projectedDeltaWeightPct = totalAssets > 0
        ? rounded(-estimatedAmount / totalAssets * 100)
        : 0
      return {
        priority: item.priority,
        action: item.action,
        code: item.code,
        name: item.name,
        concept: item.concept,
        currentWeightPct,
        requestedTargetWeightPct: targetWeightPct,
        targetWeightPct,
        deltaWeightPct,
        projectedWeightPct: rounded(
          Math.max(0, currentWeightPct + projectedDeltaWeightPct),
        ),
        projectedDeltaWeightPct,
        referencePrice: rounded(referencePrice, 3),
        estimatedAmount,
        ...execution,
        estimatedLots,
        sellableLots,
        remainingLots: Math.max(0, desiredLots - estimatedLots),
        t1Blocked: desiredLots > sellableLots,
        trigger: item.trigger,
        invalidation: item.invalidation,
        reason: item.reason,
        evidenceIds: item.evidenceIds,
      }
    })

  const estimatedSellAmount = rounded(
    sellOrders.reduce(
      (sum, item) => sum + item.estimatedAmount,
      0,
    ),
  )
  const estimatedSellNetProceeds = rounded(
    sellOrders.reduce(
      (sum, item) => sum + item.estimatedCashImpact,
      0,
    ),
    2,
  )
  const targetCash = totalAssets * (100 - targetPositionPct) / 100
  let remainingBuyCapacity = positive(
    distribution.cash - targetCash + estimatedSellNetProceeds,
  )
  const buyBudget = rounded(remainingBuyCapacity, 2)
  const buySeeds = [
    ...stockActions
      .filter((item) => item.action === 'add')
      .map((item) => ({ ...item, action: 'add' })),
    ...recommendedStocks.map((item) => ({
      ...item,
      action: 'buy',
      currentWeightPct: 0,
      qty: 0,
    })),
  ].sort((left, right) => left.priority - right.priority)
  const buyOrders = buySeeds.map((item) => {
    const currentWeightPct = rounded(item.currentWeightPct)
    const targetWeightPct = Math.max(
      currentWeightPct,
      rounded(clamp(
        item.targetWeightPct || item.maxWeightPct,
      )),
    )
    const deltaWeightPct = rounded(
      targetWeightPct - currentWeightPct,
    )
    const referencePrice = positive(
      item.triggerPrice || item.price,
    )
    const desiredAmount = positive(
      deltaWeightPct / 100 * totalAssets,
    )
    const desiredLots = referencePrice > 0
      ? Math.floor(desiredAmount / (referencePrice * 100) + 1e-9)
      : 0
    const affordable = referencePrice > 0
      ? affordableBuyLots(
          referencePrice,
          desiredLots,
          remainingBuyCapacity,
        )
      : { lots: 0, estimate: estimateExecution('BUY', 0, 0) }
    const estimatedLots = affordable.lots
    const estimatedAmount = rounded(
      estimatedLots * referencePrice * 100,
    )
    const projectedDeltaWeightPct = totalAssets > 0
      ? rounded(estimatedAmount / totalAssets * 100)
      : 0
    remainingBuyCapacity = Math.max(
      0,
      remainingBuyCapacity - affordable.estimate.estimatedCashImpact,
    )
    return {
      priority: item.priority,
      action: item.action,
      code: item.code,
      name: item.name,
      concept: item.concept,
      currentWeightPct,
      requestedTargetWeightPct: targetWeightPct,
      targetWeightPct,
      deltaWeightPct,
      projectedWeightPct: rounded(
        currentWeightPct + projectedDeltaWeightPct,
      ),
      projectedDeltaWeightPct,
      referencePrice: rounded(referencePrice, 3),
      estimatedAmount,
      ...affordable.estimate,
      estimatedLots,
      sellableLots: 0,
      remainingLots: Math.max(0, desiredLots - estimatedLots),
      t1Blocked: false,
      trigger: item.trigger,
      invalidation: item.invalidation,
      reason: item.reason,
      evidenceIds: item.evidenceIds,
    }
  })
  const orders = [...sellOrders, ...buyOrders]
    .sort((left, right) => left.priority - right.priority)
  const estimatedBuyAmount = rounded(
    buyOrders.reduce(
      (sum, item) => sum + item.estimatedAmount,
      0,
    ),
  )
  const estimatedBuyCashOutflow = rounded(
    buyOrders.reduce(
      (sum, item) => sum + item.estimatedCashImpact,
      0,
    ),
    2,
  )
  const estimatedFees = rounded(
    orders.reduce(
      (sum, item) => sum + item.estimatedFees,
      0,
    ),
    2,
  )
  const projectedPositionPct = totalAssets > 0
    ? rounded(
        distribution.positionPct
        + (estimatedBuyAmount - estimatedSellAmount)
          / totalAssets * 100,
      )
    : 0
  const deltaByConcept = new Map()
  for (const order of orders) {
    deltaByConcept.set(
      order.concept,
      rounded(
        (deltaByConcept.get(order.concept) || 0)
        + order.projectedDeltaWeightPct,
      ),
    )
  }
  const executableConceptActions = conceptActions.map((item) => ({
    ...item,
    executableTargetWeightPct: rounded(
      Math.max(
        0,
        item.currentWeightPct
        + (deltaByConcept.get(item.concept) || 0),
      ),
    ),
  }))
  const actionLabels = {
    reduce: '减持',
    exit: '退出',
    add: '加仓',
    buy: '新买',
  }
  const executableGoal = orders
    .filter((item) => item.estimatedLots > 0)
    .map((item) =>
      `${actionLabels[item.action] || item.action}${item.name}${item.estimatedLots}手`
    )
    .join('；')

  const missing = []
  if (!orders.length) missing.push('缺少明确的调仓指令')
  if (orders.some((item) => item.estimatedLots <= 0)) {
    missing.push('存在不足一手或超出资金预算的指令')
  }
  if (orders.some((item) =>
    item.referencePrice <= 0 && !item.trigger
  )) {
    missing.push('缺少执行价格或触发条件')
  }
  if (orders.some((item) => !item.invalidation)) {
    missing.push('缺少失效条件')
  }
  if (!conceptActions.length) missing.push('缺少概念增减目标')
  if (scenarioPlan.length < 2) missing.push('缺少强弱市场切换方案')
  if (!executionSummary.todayGoal || !executionSummary.nextReviewTrigger) {
    missing.push('缺少今日目标或下次复核触发器')
  }
  let score = 30
  if (orders.length) score += 25
  if (orders.length && orders.every((item) => item.estimatedLots > 0)) score += 10
  if (orders.length && orders.every((item) =>
    item.referencePrice > 0 || item.trigger
  )) score += 10
  if (orders.length && orders.every((item) => item.invalidation)) score += 10
  if (conceptActions.length) score += 5
  if (scenarioPlan.length >= 2) score += 5
  if (executionSummary.todayGoal && executionSummary.nextReviewTrigger) score += 5
  return {
    verdict: executionSummary.verdict,
    todayGoal: executableGoal || executionSummary.todayGoal,
    modelTodayGoal: executionSummary.todayGoal,
    nextReviewTrigger: executionSummary.nextReviewTrigger,
    targetPositionPct,
    targetCashReservePct: rounded(100 - targetPositionPct),
    projectedPositionPct,
    projectedCashReservePct: rounded(100 - projectedPositionPct),
    estimatedSellAmount,
    estimatedSellNetProceeds,
    estimatedBuyAmount,
    estimatedBuyCashOutflow,
    estimatedFees,
    buyBudget,
    orders,
    conceptActions: executableConceptActions,
    quality: {
      score: Math.min(100, score),
      missing,
    },
  }
}

export function normalizePortfolioAnalysis(
  input = {},
  {
    distribution = {},
    allowedEvidenceIds = [],
    allowedHoldingCodes = [],
    allowedRecommendationCodes = [],
    recommendationCatalog = {},
  } = {},
) {
  const allowedEvidence = new Set(allowedEvidenceIds)
  const holdings = new Set(allowedHoldingCodes.map(String))
  const recommendations = new Set(
    allowedRecommendationCodes.map(String),
  )
  const holdingsByCode = new Map(
    (distribution.stocks || []).map((stock) => [
      String(stock.code),
      stock,
    ]),
  )
  const positionAssessment = input.positionAssessment || {}
  const allocation = input.allocation || {}
  const targetPositionPct = rounded(
    clamp(allocation.targetPositionPct),
  )
  const categoryTargets = normalizeCategoryTargets(
    allocation.categoryTargets,
  )
  const categoryTotal = Object.values(categoryTargets)
    .reduce((sum, value) => sum + value, 0)
  const normalizedCategoryTargets = categoryTotal > targetPositionPct
    && categoryTotal > 0
    ? Object.fromEntries(
        Object.entries(categoryTargets).map(([key, value]) => [
          key,
          rounded(value * targetPositionPct / categoryTotal),
        ]),
      )
    : categoryTargets

  const stockActions = (Array.isArray(input.stockActions)
    ? input.stockActions
    : [])
    .filter((item) => holdings.has(String(item?.code || '')))
    .map((item) => ({
      code: String(item.code),
      name: text(
        holdingsByCode.get(String(item.code))?.name || item.name,
        40,
      ),
      concept: text(
        holdingsByCode.get(String(item.code))?.concept,
        50,
      ),
      qty: positive(holdingsByCode.get(String(item.code))?.qty),
      sellableQty: positive(
        holdingsByCode.get(String(item.code))?.sellableQty
        ?? holdingsByCode.get(String(item.code))?.qty,
      ),
      price: positive(holdingsByCode.get(String(item.code))?.price),
      currentWeightPct: rounded(
        holdingsByCode.get(String(item.code))?.accountWeightPct,
      ),
      priority: priority(item.priority, 50),
      action: ['reduce', 'hold', 'watch', 'exit', 'add'].includes(
        item.action,
      ) ? item.action : 'watch',
      reducePct: rounded(clamp(item.reducePct)),
      targetWeightPct: rounded(clamp(item.targetWeightPct)),
      triggerPrice: rounded(positive(item.triggerPrice), 3),
      reason: text(item.reason, 320),
      trigger: text(item.trigger, 220),
      invalidation: text(item.invalidation, 220),
      evidenceIds: evidenceIds(item.evidenceIds, allowedEvidence),
    }))
    .filter((item) =>
      item.reason
      && (
        ['hold', 'watch'].includes(item.action)
        || item.evidenceIds.length > 0
      )
    )
    .slice(0, 20)

  const recommendedStocks = (Array.isArray(input.recommendations)
    ? input.recommendations
    : [])
    .filter((item) =>
      recommendations.has(String(item?.code || ''))
    )
    .map((item) => {
      const canonical = recommendationCatalog[String(item.code)] || {}
      return {
        concept: text(canonical.concept || item.concept, 50),
        code: String(item.code),
        name: text(canonical.name || item.name, 40),
        price: rounded(positive(canonical.price || item.price), 3),
        priority: priority(item.priority, 50),
        reason: text(item.reason, 320),
        trigger: text(item.trigger, 220),
        triggerPrice: rounded(positive(item.triggerPrice), 3),
        invalidation: text(item.invalidation, 220),
        targetWeightPct: rounded(clamp(
          item.targetWeightPct || item.maxWeightPct,
        )),
        maxWeightPct: rounded(clamp(item.maxWeightPct)),
        evidenceIds: evidenceIds(item.evidenceIds, allowedEvidence),
      }
    })
    .filter((item) =>
      item.concept
      && item.name
      && item.reason
      && item.evidenceIds.length > 0
    )
    .slice(0, 8)

  const decisionNodes = (Array.isArray(input.decisionNodes)
    ? input.decisionNodes
    : [])
    .map((item, index) => ({
      key: text(item?.key, 30) || `model-${index + 1}`,
      title: text(item?.title, 60),
      status: ['ok', 'watch', 'risk'].includes(item?.status)
        ? item.status
        : 'watch',
      conclusion: text(item?.conclusion, 280),
      evidenceIds: evidenceIds(
        item?.evidenceIds,
        allowedEvidence,
      ),
    }))
    .filter((item) => item.title && item.conclusion)
    .slice(0, 8)
  const executionSummary = {
    verdict: ['rebalance', 'defensive', 'offensive', 'hold'].includes(
      input.executionSummary?.verdict,
    ) ? input.executionSummary.verdict : 'hold',
    todayGoal: text(input.executionSummary?.todayGoal, 280),
    nextReviewTrigger: text(
      input.executionSummary?.nextReviewTrigger,
      280,
    ),
  }
  const conceptActions = normalizeConceptActions(
    input.conceptActions,
    {
      distribution,
      recommendationCatalog,
      allowedEvidence,
      targetPositionPct,
    },
  )
  const scenarioPlan = normalizeScenarioPlan(input.scenarioPlan)
  const executionPlan = buildExecutionPlan({
    distribution,
    targetPositionPct,
    stockActions,
    recommendedStocks,
    executionSummary,
    conceptActions,
    scenarioPlan,
  })

  return {
    headline: text(input.headline, 120)
      || '当前仓位结构诊断已完成',
    positionAssessment: {
      score: rounded(clamp(positionAssessment.score), 0),
      level: text(positionAssessment.level, 30) || '待观察',
      rationale: text(positionAssessment.rationale, 360),
    },
    allocation: {
      targetPositionPct,
      targetCashReservePct: rounded(100 - targetPositionPct),
      categoryTargets: normalizedCategoryTargets,
      adjustments: normalizeAdjustments(allocation.adjustments),
      cashStrategy: text(allocation.cashStrategy, 320),
      dynamicRules: stringList(allocation.dynamicRules, 8, 240),
    },
    concentration: {
      level: text(input.concentration?.level, 30),
      note: text(input.concentration?.note, 320),
    },
    executionPlan,
    conceptActions: executionPlan.conceptActions,
    scenarioPlan,
    quality: executionPlan.quality,
    stockActions,
    recommendations: recommendedStocks,
    risks: stringList(input.risks, 8, 240),
    decisionNodes,
  }
}

export function fallbackPortfolioAnalysis(
  distribution = {},
  market = {},
) {
  const current = clamp(distribution.positionPct)
  const defensive = market?.regime === 'defensive'
  const target = defensive
    ? Math.min(current, 60)
    : Math.min(current, 75)
  const topConcept = distribution.groups?.[0]
  return normalizePortfolioAnalysis({
    headline: defensive
      ? '市场偏防守，优先降低集中度并保留现金'
      : '先校准集中度，再按市场强弱动态调整仓位',
    positionAssessment: {
      score: Math.max(0, 100 - Math.max(0, current - 60) * 2),
      level: current >= 85 ? '过高' : current >= 60 ? '中高' : '稳健',
      rationale: `当前总仓位${rounded(current).toFixed(1)}%，服务端未取得完整模型结论，先按风险预算给出保守诊断。`,
    },
    allocation: {
      targetPositionPct: target,
      targetCashReservePct: 100 - target,
      categoryTargets: {
        corePct: Math.min(target, 45),
        standardPct: Math.min(25, Math.max(0, target - 45)),
        satellitePct: Math.min(10, Math.max(0, target - 70)),
      },
      adjustments: topConcept?.accountWeightPct >= 35
        ? [{
            target: topConcept.name,
            action: 'reduce',
            changePct: rounded(topConcept.accountWeightPct - 30),
            reason: '单一概念占总资产超过35%，应先降到30%附近控制同向回撤。',
          }]
        : [],
      cashStrategy: `至少保留${rounded(100 - target).toFixed(1)}%现金，待市场与量化证据同步改善后再投入。`,
      dynamicRules: [
        '指数、涨跌家数与成交额同步改善后，每次提高5%至10%总仓位。',
        '市场转弱或主线退潮时，每次降低10%总仓位，优先处理高集中度弱势股。',
      ],
    },
    concentration: {
      level: topConcept?.accountWeightPct >= 35 ? '偏高' : '可控',
      note: topConcept
        ? `${topConcept.name}占总资产${rounded(topConcept.accountWeightPct).toFixed(1)}%。`
        : '暂无可识别概念。',
    },
    risks: ['模型服务降级，本结论不包含完整个股量化与联网检索判断。'],
  }, {
    distribution,
    allowedHoldingCodes: (distribution.stocks || []).map(
      (item) => item.code,
    ),
  })
}
