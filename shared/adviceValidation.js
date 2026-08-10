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

function clampPrice(value, low, high, issues, label) {
  const price = numberOf(value)
  if (!(price > 0)) return null
  if (low > 0 && price < low) {
    issues.push(`${label}低于合法价带`)
    return low
  }
  if (high > 0 && price > high) {
    issues.push(`${label}高于合法价带`)
    return high
  }
  return price
}

function appendIssue(result, issues) {
  if (!issues.length) return
  const note = issues.join('；')
  result.serverAdjust = result.serverAdjust ? `${result.serverAdjust}；${note}` : note
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
  const issues = []
  const quote = payload.todayQuote || {}
  const low = numberOf(quote.limitDownPrice)
  const high = numberOf(quote.limitUpPrice)
  let valid = true

  if (mode === 'buy_advice') {
    result.buyPrice = clampPrice(result.buyPrice, low, high, issues, '买入价')
    result.stopPrice = clampPrice(result.stopPrice, low, high, issues, '止损价')
    result.targetPrice = clampPrice(result.targetPrice, low, high, issues, '目标价')
    const action = String(result.action || '')
    const actionable = !/观望|不建议|等待/.test(action)
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
        result.actionPlan = '可用资金不足买入一手，暂不操作'
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
    result.addPrice = clampPrice(result.addPrice, low, high, issues, '加仓价')
    result.reducePrice = clampPrice(result.reducePrice, low, high, issues, '减仓价')
    result.stopPrice = clampPrice(result.stopPrice, low, high, issues, '止损价')
    result.targetPrice = clampPrice(result.targetPrice, low, high, issues, '目标价')
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

  appendIssue(result, issues)
  return { result, issues, valid }
}
