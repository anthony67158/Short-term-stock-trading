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

function nullableNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
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

function rotationStrength(order = {}, side = 'source') {
  const quantScore = nullableNumber(order.quantScore)
  if (quantScore != null) {
    return rounded(clamp(
      quantScore
      + (order.highConfidence === true ? 8 : 0)
      + clamp(order.conceptPct, -5, 5)
      + clamp(order.conceptMainInflowYi, -5, 5),
    ))
  }
  if (side === 'source') {
    return order.action === 'exit' ? 25 : 40
  }
  return 55
}

function rotationOrder(order = {}, lots = 0) {
  const estimatedLots = Math.max(0, Math.trunc(lots))
  const execution = estimateExecution(
    order.action === 'buy' ? 'BUY' : 'SELL',
    order.referencePrice,
    estimatedLots,
  )
  const referenceAmount = rounded(
    positive(order.referencePrice) * estimatedLots * 100,
    2,
  )
  const estimatedSlippage = rounded(Math.abs(
    execution.estimatedCashImpact
    - referenceAmount
    - (
      order.action === 'buy'
        ? execution.estimatedFees
        : -execution.estimatedFees
    ),
  ), 2)
  return {
    code: order.code,
    name: order.name,
    concept: order.concept,
    action: order.action,
    lots: estimatedLots,
    referencePrice: order.referencePrice,
    estimatedFillPrice: execution.estimatedFillPrice,
    estimatedFees: execution.estimatedFees,
    estimatedSlippage,
    estimatedCashImpact: execution.estimatedCashImpact,
    trigger: order.trigger,
    invalidation: order.invalidation,
    evidenceIds: order.evidenceIds,
    strengthScore: rotationStrength(
      order,
      order.action === 'buy' ? 'target' : 'source',
    ),
  }
}

function buildPrimaryRotation({
  orders = [],
  distribution = {},
  targetPositionPct = 0,
  nextReviewTrigger = '',
} = {}) {
  const sources = orders
    .filter((item) => ['reduce', 'exit'].includes(item.action))
    .sort((left, right) =>
      left.priority - right.priority
      || (left.action === 'exit' ? -1 : 1),
    )
  const targets = orders
    .filter((item) => item.action === 'buy')
    .sort((left, right) => left.priority - right.priority)
  const sourceOrder = sources[0]
  const targetOrder = targets[0]
  if (!sourceOrder || !targetOrder) return null

  const source = rotationOrder(
    sourceOrder,
    sourceOrder.estimatedLots,
  )
  const targetCashReserve = positive(distribution.totalAssets)
    * Math.max(0, 100 - targetPositionPct) / 100
  const freeCash = positive(
    positive(distribution.cash)
    - targetCashReserve
    + source.estimatedCashImpact,
  )
  const desiredTargetLots = Math.max(
    0,
    Math.trunc(
      finite(
        targetOrder.desiredLots,
        targetOrder.estimatedLots + targetOrder.remainingLots,
      ),
    ),
  )
  const affordableTarget = affordableBuyLots(
    targetOrder.referencePrice,
    desiredTargetLots,
    freeCash,
  )
  const target = rotationOrder(
    targetOrder,
    affordableTarget.lots,
  )
  const edgeScore = rounded(
    target.strengthScore - source.strengthScore,
  )
  const blockedReasons = []
  if (
    sourceOrder.t1Blocked
    && source.lots <= 0
  ) blockedReasons.push('当前待释放仓位受T+1限制')
  if (source.lots <= 0 && !sourceOrder.t1Blocked) {
    blockedReasons.push('当前没有可执行的卖出手数')
  }
  if (target.lots <= 0) {
    blockedReasons.push('释放资金与可用现金不足一手')
  }
  if (!(source.referencePrice > 0 && target.referencePrice > 0)) {
    blockedReasons.push('买卖参考价不完整')
  }
  if (!target.trigger || !target.invalidation) {
    blockedReasons.push('候选尚未形成完整触发与失效条件')
  }
  if (edgeScore < 5) {
    blockedReasons.push('候选相对现持仓的短线优势不足')
  }

  const status = edgeScore < 5
    ? 'HOLD'
    : sourceOrder.t1Blocked && source.lots <= 0
      ? 'WAIT_T1'
      : target.lots <= 0
        ? 'WAIT_CASH'
        : blockedReasons.length
          ? 'WAIT_TRIGGER'
          : 'READY'
  const totalFees = rounded(
    source.estimatedFees + target.estimatedFees,
    2,
  )
  const totalSlippage = rounded(
    source.estimatedSlippage + target.estimatedSlippage,
    2,
  )
  const totalTradingCost = rounded(totalFees + totalSlippage, 2)
  const summary = status === 'READY'
    ? `先释放${source.name}${source.lots}手，${target.trigger}后转入${target.name}${target.lots}手`
    : status === 'WAIT_T1'
      ? `${source.name}受T+1限制，下一交易日优先释放后再评估${target.name}`
      : status === 'HOLD'
        ? `暂不从${source.name}轮动到${target.name}，相对优势不足`
        : `暂缓从${source.name}轮动到${target.name}，等待执行条件补齐`

  return {
    schemaVersion: 'portfolio-rotation.v1',
    status,
    actionable: status === 'READY',
    summary,
    source,
    target,
    comparison: {
      sourceStrengthScore: source.strengthScore,
      targetStrengthScore: target.strengthScore,
      edgeScore,
      minimumEdgeScore: 5,
    },
    funding: {
      cashAboveReserve: rounded(
        Math.max(0, positive(distribution.cash) - targetCashReserve),
        2,
      ),
      sellNetProceeds: source.estimatedCashImpact,
      buyCashRequired: target.estimatedCashImpact,
      netCashChange: rounded(
        source.estimatedCashImpact - target.estimatedCashImpact,
        2,
      ),
    },
    costs: {
      fees: totalFees,
      slippage: totalSlippage,
      total: totalTradingCost,
      slippageBps: 5,
    },
    t1: {
      sourceBlocked: sourceOrder.t1Blocked === true,
      sourceRemainingLots: Math.max(
        0,
        Math.trunc(sourceOrder.remainingLots),
      ),
      targetLockedAfterBuy: target.lots > 0,
      note: target.lots > 0
        ? '新买仓位当日不可卖出，需承担隔夜风险'
        : '本轮未增加新的隔夜仓位',
    },
    blockedReasons,
    nextReviewTrigger: text(
      nextReviewTrigger || target.trigger || source.trigger,
      220,
    ),
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
        desiredLots,
        estimatedLots,
        sellableLots,
        remainingLots: Math.max(0, desiredLots - estimatedLots),
        t1Blocked: desiredLots > sellableLots,
        trigger: item.trigger,
        invalidation: item.invalidation,
        reason: item.reason,
        evidenceIds: item.evidenceIds,
        quantScore: item.quantScore,
        highConfidence: item.highConfidence,
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
  const reservedCash = positive(distribution.reservedBuyCash)
  let currentBuyCapacity = positive(distribution.cash - targetCash - reservedCash)
  const currentBuyBudget = rounded(currentBuyCapacity, 2)
  let remainingBuyCapacity = positive(
    distribution.cash - targetCash - reservedCash + estimatedSellNetProceeds,
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
    const current = referencePrice > 0
      ? affordableBuyLots(referencePrice, estimatedLots, currentBuyCapacity)
      : { lots: 0, estimate: estimateExecution('BUY', 0, 0) }
    currentBuyCapacity = Math.max(
      0, currentBuyCapacity - current.estimate.estimatedCashImpact,
    )
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
      desiredLots,
      estimatedLots,
      currentExecutableLots: current.lots,
      requiresSellSettlement: current.lots < estimatedLots,
      sellableLots: 0,
      remainingLots: Math.max(0, desiredLots - estimatedLots),
      t1Blocked: false,
      trigger: item.trigger,
      invalidation: item.invalidation,
      reason: item.reason,
      evidenceIds: item.evidenceIds,
      quantScore: item.quantScore,
      highConfidence: item.highConfidence,
      conceptPct: item.conceptPct,
      conceptMainInflowYi: item.conceptMainInflowYi,
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

  const intentionalHold = (
    executionSummary.verdict === 'hold'
    && orders.length === 0
  )
  const missing = []
  if (!orders.length && !intentionalHold) {
    missing.push('缺少明确的调仓指令')
  }
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
  let score = intentionalHold ? 75 : 30
  if (orders.length) score += 25
  if (orders.length && orders.every((item) => item.estimatedLots > 0)) score += 10
  if (orders.length && orders.every((item) =>
    item.referencePrice > 0 || item.trigger
  )) score += 10
  if (orders.length && orders.every((item) => item.invalidation)) score += 10
  if (conceptActions.length) score += 5
  if (scenarioPlan.length >= 2) score += 5
  if (executionSummary.todayGoal && executionSummary.nextReviewTrigger) score += 5
  const primaryRotation = buildPrimaryRotation({
    orders,
    distribution,
    targetPositionPct,
    nextReviewTrigger: executionSummary.nextReviewTrigger,
  })
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
    currentBuyBudget,
    primaryRotation,
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
    holdingCatalog = {},
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
    .map((item) => {
      const code = String(item.code)
      const holding = holdingsByCode.get(code) || {}
      const canonical = holdingCatalog[code] || {}
      return {
        code,
        name: text(holding.name || item.name, 40),
        concept: text(holding.concept, 50),
        qty: positive(holding.qty),
        sellableQty: positive(
          holding.sellableQty ?? holding.qty,
        ),
        price: positive(holding.price),
        currentWeightPct: rounded(holding.accountWeightPct),
        floatPct: rounded(holding.floatPct),
        quantScore: nullableNumber(
          canonical.quantScore ?? canonical.quant?.score,
        ),
        highConfidence:
          canonical.highConfidence === true
          || canonical.quant?.highConfSignal?.fired === true,
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
      }
    })
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
        quantScore: nullableNumber(
          canonical.quantScore ?? canonical.quant?.score,
        ),
        highConfidence:
          canonical.highConfidence === true
          || canonical.quant?.highConfSignal?.fired === true,
        conceptPct: nullableNumber(canonical.conceptPct),
        conceptMainInflowYi: nullableNumber(
          canonical.conceptMainInflowYi,
        ),
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

export function buildV3PortfolioAnalysis({
  distribution = {},
  adviceByCode = {},
  evidenceIds: sourceEvidenceIds = [],
  quantEvidenceIds = {},
  now = Date.now(),
} = {}) {
  const allowedEvidenceIds = [...new Set(
    sourceEvidenceIds.filter(Boolean),
  )]
  const totalAssets = positive(distribution.totalAssets)
  const projectedByCode = new Map()
  const missingV3 = []
  const stockActions = (distribution.stocks || []).map((stock, index) => {
    const entry = adviceByCode?.[stock.code]
    const advice = entry?.advice || entry || {}
    const source = advice.decisionSource || {}
    const plan = advice.decisionPlan || {}
    const currentWeightPct = rounded(stock.accountWeightPct)
    const referencePrice = positive(
      plan.prices?.reference || stock.price,
    )
    const quantityLots = Math.max(
      0,
      Math.trunc(finite(plan.quantity?.lots)),
    )
    const expiresAt = Date.parse(plan.validUntil)
    const current = (
      source.engine === 'V3'
      && source.state === 'READY'
      && plan.decisionId
      && Number.isFinite(expiresAt)
      && expiresAt > now
    )
    const reviewedExit = (
      source.hardProtection === true
      || source.exitReviewRequired === false
      || advice.reviewDecision?.terminal === true
    )
    let action = 'hold'
    if (
      current
      && plan.actionability === 'READY'
      && quantityLots > 0
    ) {
      if (['EXIT', 'REDUCE'].includes(plan.action)) {
        action = reviewedExit
          ? plan.action === 'EXIT' ? 'exit' : 'reduce'
          : 'watch'
      } else if (plan.action === 'ADD') {
        action = 'add'
      }
    } else if (
      current
      && ['EXIT', 'REDUCE'].includes(plan.action)
      && !reviewedExit
    ) {
      action = 'watch'
    }
    if (!current) missingV3.push(stock.code)

    const deltaWeightPct = (
      totalAssets > 0
      && referencePrice > 0
      && quantityLots > 0
    ) ? quantityLots * 100 * referencePrice / totalAssets * 100 : 0
    const targetWeightPct = action === 'exit'
      ? 0
      : action === 'reduce'
        ? Math.max(0, currentWeightPct - deltaWeightPct)
        : action === 'add'
          ? Math.min(100, currentWeightPct + deltaWeightPct)
          : currentWeightPct
    projectedByCode.set(stock.code, targetWeightPct)
    const evidence = [
      quantEvidenceIds[stock.code],
      ...allowedEvidenceIds,
    ].filter(Boolean)
    const reason = text(
      advice.actionPlan
      || (
        current
          ? '当前V3没有核定新的调仓动作'
          : '当前没有有效且未过期的V3决策'
      ),
      320,
    )
    return {
      priority: index + 1,
      code: stock.code,
      name: stock.name,
      action,
      targetWeightPct: rounded(targetWeightPct),
      triggerPrice: rounded(referencePrice, 3),
      trigger: text(plan.trigger || advice.actionPlan, 220),
      invalidation: text(
        advice.invalidation
        || '报价、账户交易事实或V3决策版本变化后重新评估',
        220,
      ),
      reason,
      evidenceIds: evidence.slice(0, 8),
    }
  })

  stockActions.sort((left, right) => {
    const rank = { exit: 0, reduce: 1, add: 2, watch: 3, hold: 4 }
    return rank[left.action] - rank[right.action]
      || left.priority - right.priority
  })
  stockActions.forEach((item, index) => {
    item.priority = index + 1
  })

  const targetPositionPct = rounded(
    (distribution.stocks || []).reduce(
      (sum, stock) =>
        sum + (projectedByCode.get(stock.code) || 0),
      0,
    ),
  )
  const categoryTargets = {
    corePct: 0,
    standardPct: 0,
    satellitePct: 0,
  }
  const categoryKey = {
    '核心仓': 'corePct',
    '标准仓': 'standardPct',
    '卫星仓': 'satellitePct',
  }
  for (const stock of (distribution.stocks || [])) {
    const key = categoryKey[stock.category]
    if (!key) continue
    categoryTargets[key] = rounded(
      categoryTargets[key]
      + (projectedByCode.get(stock.code) || 0),
    )
  }

  const conceptTargets = new Map()
  for (const stock of (distribution.stocks || [])) {
    conceptTargets.set(
      stock.concept,
      rounded(
        (conceptTargets.get(stock.concept) || 0)
        + (projectedByCode.get(stock.code) || 0),
      ),
    )
  }
  const conceptActions = [...conceptTargets.entries()].map(
    ([concept, targetWeightPct]) => ({
      concept,
      targetWeightPct,
      reason: '由当前持仓和已核定V3动作汇总',
      evidenceIds: allowedEvidenceIds.slice(0, 3),
    }),
  )
  const executable = stockActions.filter((item) =>
    ['exit', 'reduce', 'add'].includes(item.action)
  )
  const todayGoal = executable.length
    ? executable.map((item) =>
        `${{
          exit: '退出',
          reduce: '减仓',
          add: '加仓',
        }[item.action]}${item.name}`
      ).join('；')
    : '当前没有经过V3核定的新调仓动作'
  const topConcept = distribution.groups?.[0]
  const positionScore = Math.max(
    0,
    Math.round(100 - Math.max(0, targetPositionPct - 60) * 2),
  )
  const normalized = normalizePortfolioAnalysis({
    headline: executable.length
      ? '按当前V3决策执行组合调整'
      : '当前组合维持原仓位，等待新的V3决策',
    executionSummary: {
      verdict: executable.length ? 'rebalance' : 'hold',
      todayGoal,
      nextReviewTrigger:
        '任一股票V3决策、价格或账户交易事实变化后重新汇总',
    },
    positionAssessment: {
      score: positionScore,
      level: targetPositionPct >= 85
        ? '过高'
        : targetPositionPct >= 60 ? '中性' : '稳健',
      rationale:
        `当前仓位${rounded(distribution.positionPct)}%，`
        + `按已核定V3动作预计为${targetPositionPct}%。`,
    },
    allocation: {
      targetPositionPct,
      targetCashReservePct: rounded(100 - targetPositionPct),
      categoryTargets,
      adjustments: conceptActions.map((item) => {
        const current = finite(
          (distribution.groups || []).find(
            (group) => group.name === item.concept,
          )?.accountWeightPct,
        )
        return {
          target: item.concept,
          action: item.targetWeightPct > current + 0.1
            ? 'increase'
            : item.targetWeightPct < current - 0.1
              ? 'reduce'
              : 'hold',
          changePct: rounded(Math.abs(item.targetWeightPct - current)),
          reason: item.reason,
        }
      }),
      cashStrategy:
        `按当前V3动作预计保留${rounded(100 - targetPositionPct)}%现金。`,
      dynamicRules: [
        '只有新的V3决策可以改变个股动作、价格和手数。',
        '账户成交、T+1或现金变化后立即重新汇总。',
      ],
    },
    concentration: {
      level: finite(topConcept?.accountWeightPct) >= 35
        ? '偏高'
        : '可控',
      note: topConcept
        ? `${topConcept.name}当前占总资产${rounded(topConcept.accountWeightPct)}%。`
        : '暂无可识别概念。',
    },
    stockActions,
    recommendations: [],
    conceptActions,
    scenarioPlan: [
      {
        regime: 'strong',
        signal: '市场转强且个股形成新的V3正期望决策',
        targetPositionPct,
        actions: ['重新运行V3并只执行最新核定动作'],
      },
      {
        regime: 'weak',
        signal: '市场转弱、价格触及风险边界或账户事实变化',
        targetPositionPct,
        actions: ['重新运行V3；账本硬止损优先'],
      },
    ],
    risks: missingV3.length
      ? [`${missingV3.join('、')}缺少当前有效V3决策，未生成调仓动作`]
      : [],
    decisionNodes: executable.map((item) => ({
      key: 'stock',
      title: `${item.name}${{
        exit: '退出',
        reduce: '减仓',
        add: '加仓',
      }[item.action]}`,
      status: ['exit', 'reduce'].includes(item.action)
        ? 'risk'
        : 'ok',
      conclusion: item.reason,
      evidenceIds: item.evidenceIds,
    })),
  }, {
    distribution,
    allowedEvidenceIds,
    allowedHoldingCodes: (distribution.stocks || []).map(
      (stock) => stock.code,
    ),
    holdingCatalog: Object.fromEntries(
      (distribution.stocks || []).map((stock) => {
        const advice = adviceByCode?.[stock.code]?.advice
          || adviceByCode?.[stock.code]
          || {}
        const score = advice.selectedV3Plan?.opportunityScore || {}
        return [stock.code, {
          quantScore: nullableNumber(score.pWinGivenFill) == null
            ? null
            : rounded(score.pWinGivenFill * 100),
          highConfidence: nullableNumber(score.expectedNetR) > 0,
        }]
      }),
    ),
    recommendationCatalog: {},
  })
  normalized.decisionAuthority = {
    engine: 'V3',
    llmMayChangeDecision: false,
    generatedAt: now,
  }
  return normalized
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
