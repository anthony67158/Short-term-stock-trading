import {
  adviceObservationLevels,
  buildAdvicePriceContract,
} from './advicePriceContract.js'
import { timeBoundReviewText } from './userFacingLanguage.js'

function numberOf(value) {
  if (value == null || value === '') return null
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : Number(value)
  return Number.isFinite(number) ? number : null
}

function handsOf(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*手/)
  return match ? Math.max(0, Math.trunc(Number(match[1]))) : Math.max(0, Math.trunc(numberOf(value) || 0))
}

function roundMoney(value) {
  return Math.round(Number(value) || 0)
}

function validatePrice(value, low, high, issues, label) {
  const price = numberOf(value)
  if (!(price > 0)) {
    issues.push(`${label}不是有效正数`)
    return null
  }
  if (low > 0 && price < low) {
    issues.push(`${label}低于合法价带`)
    return null
  }
  if (high > 0 && price > high) {
    issues.push(`${label}高于合法价带`)
    return null
  }
  return +(price < 10 ? price.toFixed(3) : price.toFixed(2))
}

function appendIssue(result, issues) {
  if (!issues.length) return
  const note = issues.join('；')
  result.serverAdjust = result.serverAdjust ? `${result.serverAdjust}；${note}` : note
}

function continuousExecutionOpen(payload = {}) {
  const phase = String(
    payload.todayQuote?.phase
    || payload.marketPhase
    || '',
  )
  if (
    /非交易|盘前|集合竞价|午间|休市|盘后|已收盘/.test(phase)
  ) return false
  if (/早盘|午盘|盘中/.test(phase)) return true
  return payload.todayQuote?.live !== false
}

function nextSessionPlanText(payload = {}) {
  const plan =
    payload.shortHorizonTactical?.actionPolicy?.nextSessionPlan
  if (!plan || !['PROBE', 'BUY'].includes(plan.action)) return null
  const sessionLabel = {
    AFTERNOON: '下午盘中',
    OPENING: '开盘后',
    NEXT_TRADING_DAY: '下一交易日盘中',
  }[plan.session] || '下一交易时段盘中'
  return {
    sessionLabel,
    actionLabel: String(
      plan.actionLabel
      || (
        plan.action === 'PROBE'
          ? '条件试仓'
          : '条件买入'
      ),
    ),
    reviewMode: plan.reviewMode || 'ENTRY_CONFIRMATION',
  }
}

function primaryObservationPath({
  pullback = null,
  breakout = null,
  payload = {},
  result = {},
} = {}) {
  const timingState = String(
    payload.shortHorizonTactical?.timing?.state || '',
  )
  if (timingState === 'WAIT_BREAKOUT' && breakout) return breakout
  if (timingState === 'WAIT_PULLBACK' && pullback) return pullback

  const originalText = String(
    result.timing || result.actionPlan || result.reason || '',
  )
  const mentionsBreakout = /突破|站上|站稳/.test(originalText)
  const mentionsPullback = /回踩|回调|低吸/.test(originalText)
  if (mentionsBreakout && !mentionsPullback && breakout) return breakout
  if (mentionsPullback && !mentionsBreakout && pullback) return pullback

  const current = numberOf(
    payload.todayQuote?.price ?? payload.currentPrice,
  )
  if (current > 0 && pullback && breakout) {
    const pullbackDistance = Math.abs(current - pullback.price) / current
    const breakoutDistance = Math.abs(current - breakout.price) / current
    return breakoutDistance <= pullbackDistance ? breakout : pullback
  }
  return breakout || pullback || null
}

function observationActionPlan({
  observation = null,
  executionPrefix = '',
} = {}) {
  if (!observation) {
    return `${executionPrefix}暂无近期有效触发价；当前不买，等待量价与资金出现新变化后重新评估`
  }
  const price = observation.price
  if (observation.direction === 'GTE') {
    return `当前不买；${executionPrefix}只看${price}元：盘中放量站稳后自动复核一次，通过后按新指令的价格和手数手动买入；未放量或跌回${price}元下方不买`
  }
  return `当前不买；${executionPrefix}只看${price}元：回踩不破并重新站回分时均价后自动复核一次，通过后按新指令的价格和手数手动买入；跌破${price}元不买`
}

function deferBuyToObservation(result, payload, issues) {
  const quote = payload.todayQuote || {}
  const currentPrice = numberOf(
    quote.price ?? payload.currentPrice,
  )
  const buyPrice = numberOf(result.buyPrice)
  const executionOpen = continuousExecutionOpen(payload)
  if (!(buyPrice > 0) || !(currentPrice > 0)) return false
  const aboveCurrent = buyPrice > currentPrice
  if (!aboveCurrent && executionOpen) return false

  if (aboveCurrent) {
    result.breakoutWatchPrice = buyPrice
  } else {
    result.pullbackWatchPrice = buyPrice
  }
  result.action = '观望'
  result.stance = result.stance ? '观望' : result.stance
  result.tier = 'wait'
  result.tone = 'muted'
  result.buyPrice = null
  result.buyZone = null
  result.stopPrice = null
  result.targetPrice = null
  result.planQty = 0
  result.planQtyNum = 0
  result.planAmount = 0
  const phasePrefix = executionOpen ? '' : '下一交易时段盘中，'
  result.actionPlan = aboveCurrent
    ? `当前不买；${phasePrefix}只看${buyPrice}元：盘中放量站稳后立即复核一次，通过后按新指令的价格和手数手动买入；未放量或跌回${buyPrice}元下方不买`
    : `当前不买；${phasePrefix}只看${buyPrice}元：回踩不破并重新站回分时均价后立即复核一次，通过后按新指令的价格和手数手动买入；跌破${buyPrice}元不买`
  result.timing = result.actionPlan
  if (aboveCurrent) {
    issues.push(
      `模型买入价${buyPrice}元高于当前价${currentPrice}元，已改为突破观察价`,
    )
  }
  if (!executionOpen) {
    const phase = String(quote.phase || payload.marketPhase || '')
    const phaseLabel = /盘后|已收盘/.test(phase)
      ? '当前已收盘'
      : /午间/.test(phase)
        ? '当前午间休市'
        : /盘前|集合竞价/.test(phase)
          ? '当前尚未进入连续竞价'
          : '当前不在连续竞价时段'
    issues.push(
      `${phaseLabel}，买入计划已改为下一交易时段盘中观察`,
    )
  }
  return true
}

function reconcileActionText(text, quantity, amount) {
  if (typeof text !== 'string' || !(quantity >= 0)) return text
  let output = text.replace(
    /((?:立即|先|计划|建议)?(?:买入|买|加仓|接回|买回|减仓|减|卖出|卖|清仓)\s*)\d+(?:\.\d+)?\s*手/g,
    `$1${quantity}手`,
  )
  if (amount >= 0) {
    output = output.replace(
      /((?:约需|约用|需用|回笼|支出|合计|金额)\s*)[\d,]+(?:\.\d+)?\s*元/g,
      `$1${amount}元`,
    )
  }
  return output
}

export function reconcileAdviceNumbers({ mode, result: input, payload = {} } = {}) {
  const result = input && typeof input === 'object' ? { ...input } : {}
  for (const field of [
    'actionPlan',
    'invalidation',
    'nextAction',
    'reason',
    'timing',
  ]) {
    if (typeof result[field] === 'string') {
      result[field] = timeBoundReviewText(result[field])
    }
  }
  const issues = []
  const quote = payload.todayQuote || {}
  const low = numberOf(quote.limitDownPrice)
  const high = numberOf(quote.limitUpPrice)
  let valid = true
  const initialAction = String(result.action || result.stance || '')
  let unownedWait = mode === 'buy_advice'
    && /观望|等待|回避|不建议|暂不|放弃买入/.test(initialAction)
  if (unownedWait) {
    const hadIrrelevantPrices = [
      result.buyPrice,
      result.buyZone,
      result.stopPrice,
      result.targetPrice,
    ].some((value) => value != null && value !== '')
    result.buyPrice = null
    result.buyZone = null
    result.stopPrice = null
    result.targetPrice = null
    if (hadIrrelevantPrices) {
      issues.push('未持仓观望已移除无执行意义的买入、止损和目标价')
    }
  }
  const labels = {
    buyPrice: '买入价',
    addPrice: '加仓价',
    reducePrice: '减仓价',
    stopPrice: '止损价',
    targetPrice: '目标价',
    watchPrice: '观察价',
    pullbackWatchPrice: '回踩观察价',
    breakoutWatchPrice: '突破观察价',
    leg1Price: '第一腿价',
    leg2Price: '第二腿价',
  }
  const fields = mode === 'buy_advice'
    ? [
        'buyPrice',
        'stopPrice',
        'targetPrice',
        'pullbackWatchPrice',
        'breakoutWatchPrice',
        'watchPrice',
      ]
    : mode === 't_advice'
      ? ['leg1Price', 'leg2Price', 'stopPrice', 'targetPrice']
      : ['addPrice', 'reducePrice', 'stopPrice', 'targetPrice']
  for (const field of fields) {
    if (result[field] == null) continue
    const supplied = result[field]
    result[field] = validatePrice(
      result[field],
      low,
      high,
      issues,
      labels[field],
    )
    if (supplied != null && result[field] == null) valid = false
  }
  if (
    mode === 'buy_advice'
    && !unownedWait
    && deferBuyToObservation(result, payload, issues)
  ) {
    valid = false
    unownedWait = true
  }
  const initialPriceContract = buildAdvicePriceContract({
    mode,
    advice: result,
    payload,
  })
  if (initialPriceContract.validationStatus !== 'UNAVAILABLE') {
    issues.push(...initialPriceContract.issues)
    if (
      result.buyZone != null
      && initialPriceContract.zones?.buy?.strict !== true
    ) {
      valid = false
      result.buyZone = null
      issues.push('买入区间未通过价格依据校验')
    }
    for (const level of initialPriceContract.levels) {
      if (level.strict) continue
      valid = false
      result[level.field] = null
      issues.push(
        `${labels[level.field] || level.field}未通过价格依据校验`,
      )
    }
  }
  if (mode === 'buy_advice') {
    const action = String(result.action || '')
    const actionable = !/观望|不建议|等待|放弃买入/.test(action)
    if (actionable && (!(result.buyPrice > 0) || !(result.stopPrice > 0) || !(result.targetPrice > 0)
      || result.stopPrice >= result.buyPrice || result.targetPrice <= result.buyPrice)) {
      valid = false
      issues.push('买入价、止损价与目标价关系非法，已降级观望')
      result.action = '观望'
      result.tier = 'wait'
      result.tone = 'muted'
      result.buyPrice = null
      result.buyZone = null
      result.stopPrice = null
      result.targetPrice = null
      result.planQty = 0
      result.planQtyNum = 0
      result.planAmount = 0
    } else if (actionable) {
      let quantity = handsOf(result.planQtyNum ?? result.planQty)
      const cash = numberOf(payload.account?.cash)
      if (cash != null && result.buyPrice > 0) {
        const affordable = Math.max(0, Math.floor(cash / (result.buyPrice * 100)))
        if (quantity > affordable) {
          quantity = affordable
          issues.push('买入手数超过可用资金')
        }
      }
      if (quantity <= 0) {
        valid = false
        issues.push('可用资金不足一手，已降级观望')
        result.action = '观望'
        result.tier = 'wait'
        result.tone = 'muted'
        result.buyPrice = null
        result.buyZone = null
        result.stopPrice = null
        result.targetPrice = null
        result.planQty = 0
        result.planQtyNum = 0
        result.planAmount = 0
        result.actionPlan = '可用资金不足买入一手，本次不买入'
        appendIssue(result, issues)
        return { result, issues, valid }
      }
      result.planQty = quantity
      result.planQtyNum = quantity
      result.planAmount = roundMoney(quantity * 100 * result.buyPrice)
      result.actionPlan = reconcileActionText(result.actionPlan, quantity, result.planAmount)
      result.nextAction = reconcileActionText(result.nextAction, quantity, result.planAmount)
      result.riskAmount = `约亏损${roundMoney((result.buyPrice - result.stopPrice) * quantity * 100)}元`
      const expected = roundMoney((result.targetPrice - result.buyPrice) * quantity * 100)
      const expectedPct = result.buyPrice > 0
        ? +((result.targetPrice - result.buyPrice) / result.buyPrice * 100).toFixed(2)
        : 0
      result.expReturn = `约盈利${expected}元（${expectedPct >= 0 ? '+' : ''}${expectedPct}%）`
      const risk = result.buyPrice - result.stopPrice
      result.riskReward = risk > 0 ? `${+((result.targetPrice - result.buyPrice) / risk).toFixed(2)}:1` : null
    } else {
      result.planQty = 0
      result.planQtyNum = 0
      result.planAmount = 0
    }
  }

  if (mode === 'hold_advice' || mode === 'review') {
    if (result.stopPrice > 0 && result.targetPrice > 0 && result.stopPrice >= result.targetPrice) {
      valid = false
      issues.push('止损价不得高于或等于目标价')
      result.stopPrice = null
    }

    const action = String(result.action || result.stance || '')
    const holdQuantity = Math.max(0, Math.trunc(numberOf(payload.holdQty) || 0))
    const sellable = Math.max(0, Math.min(
      holdQuantity,
      Math.trunc(numberOf(payload.sellableTodayQty) ?? holdQuantity),
    ))
    let quantity = handsOf(result.opQty)
    const selling = /减仓|清仓|卖出/.test(action) || /减仓|清仓|卖出/.test(String(result.opQty || ''))
    const adding = /加仓|买入|接回|买回/.test(action) || /加仓|买入|接回|买回/.test(String(result.opQty || ''))
    if (selling && quantity > sellable) {
      quantity = sellable
      issues.push('卖出手数超过今日可卖数量')
    }
    if (adding) {
      const cash = numberOf(payload.account?.cash)
      if (cash != null && result.addPrice > 0) {
        const affordable = Math.max(0, Math.floor(cash / (result.addPrice * 100)))
        if (quantity > affordable) {
          quantity = affordable
          issues.push('加仓手数超过可用资金')
        }
      }
    }
    if ((selling || adding) && quantity <= 0) {
      const noSellable = selling && sellable <= 0
      if (result.action) result.action = '持有'
      if (result.stance) result.stance = '持有'
      result.opQty = '无需操作'
      result.opAmount = 0
      result.newCost = numberOf(payload.holdCost) ?? result.newCost
      result.actionPlan = noSellable ? '今日无可卖仓位，继续持有等待下一交易日' : '可用资金不足一手，暂不加仓'
      result.nextAction = result.actionPlan
      issues.push(noSellable ? '今日无可卖数量，卖出建议已降级持有' : '可用资金不足一手，加仓建议已降级持有')
    }
    if ((selling || adding) && quantity > 0) {
      const requestedClear = selling && /清仓/.test(action)
      const verb = selling ? (requestedClear && quantity >= holdQuantity ? '清仓' : '减仓') : '加仓'
      if (requestedClear && quantity < holdQuantity) {
        if (result.action) result.action = '减仓'
        if (result.stance) result.stance = '减仓'
        issues.push('今日可卖数量不足，清仓已改为减仓')
      }
      result.opQty = `${verb}${quantity}手`
      const price = selling ? result.reducePrice : result.addPrice
      result.opAmount = price > 0 ? roundMoney(quantity * 100 * price) : 0
      for (const field of ['actionPlan', 'nextAction', 'reason', 'positionNote', 'plain']) {
        result[field] = reconcileActionText(result[field], quantity, result.opAmount)
      }
      const cost = numberOf(payload.holdCost)
      if (adding && cost > 0 && result.addPrice > 0) {
        result.newCost = +((cost * holdQuantity + result.addPrice * quantity) / (holdQuantity + quantity)).toFixed(3)
      } else if (cost != null) {
        result.newCost = cost
      }
    }

    const cost = numberOf(payload.holdCost)
    if (cost > 0 && holdQuantity > 0 && result.stopPrice > 0) {
      const pnlAtStop = roundMoney((result.stopPrice - cost) * holdQuantity * 100)
      result.riskAmount = pnlAtStop >= 0
        ? `触发止损时仍盈利${pnlAtStop}元`
        : `触发止损时约亏损${Math.abs(pnlAtStop)}元`
    }
    if (cost > 0 && holdQuantity > 0 && result.targetPrice > 0) {
      const profit = roundMoney((result.targetPrice - cost) * holdQuantity * 100)
      const pct = +((result.targetPrice - cost) / cost * 100).toFixed(2)
      result.expReturn = `${profit >= 0 ? '约盈利' : '约亏损'}${Math.abs(profit)}元（${pct >= 0 ? '+' : ''}${pct}%）`
    }
  }

  if (mode === 't_advice') {
    const first = numberOf(result.leg1Price)
    const second = numberOf(result.leg2Price)
    const validLegs = result.dir === 'positive'
      ? first > 0 && second > first
      : result.dir === 'reverse'
        ? first > 0 && second > 0 && second < first
        : true
    if (!validLegs) {
      valid = false
      result.advisable = '不建议'
      result.dir = 'none'
      result.dirLabel = '暂不做T'
      result.leg1Price = null
      result.leg2Price = null
      result.suggestQty = 0
      issues.push('做T两腿价格关系非法，已取消本次计划')
    }
  }

  let finalPriceContract = buildAdvicePriceContract({
    mode,
    advice: result,
    payload,
  })
  if (unownedWait) {
    const observations = adviceObservationLevels({
      priceContract: finalPriceContract,
    })
    const pullback = observations.find((item) =>
      item.key === 'watch_pullback'
      || item.direction === 'LTE'
    )
    const breakout = observations.find((item) =>
      item.key === 'watch_breakout'
      || item.direction === 'GTE'
    )
    result.pullbackWatchPrice = pullback?.price ?? null
    result.breakoutWatchPrice = breakout?.price ?? null
    result.watchPrice = null
    const executionOpen = continuousExecutionOpen(payload)
    const nextSessionPlan = executionOpen
      ? null
      : nextSessionPlanText(payload)
    const executionPrefix = nextSessionPlan
      ? `${nextSessionPlan.sessionLabel}${nextSessionPlan.actionLabel}：`
      : executionOpen
        ? ''
        : '下一交易时段盘中，'
    const primaryObservation = primaryObservationPath({
      pullback,
      breakout,
      payload,
      result,
    })
    result.actionPlan = observationActionPlan({
      observation: primaryObservation,
      executionPrefix,
    })
    result.timing = result.actionPlan
    finalPriceContract = buildAdvicePriceContract({
      mode,
      advice: result,
      payload,
    })
  }
  result.priceContract = {
    ...finalPriceContract,
    issues: [...new Set([
      ...initialPriceContract.issues,
      ...finalPriceContract.issues,
      ...issues.filter((item) => /价|价格|区间/.test(item)),
    ])],
  }
  appendIssue(result, issues)
  return { result, issues, valid }
}
