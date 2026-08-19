const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const quantity = (value) => Math.max(0, Math.trunc(Number(value) || 0))

const price = (value) => {
  const number = finite(value)
  if (!(number > 0)) return null
  return number < 10 ? +number.toFixed(3) : +number.toFixed(2)
}

function prefixPlan(result, text, field = 'actionPlan') {
  const current = String(result[field] || '').trim()
  if (current.includes(text)) return
  result[field] = current ? `${text}；${current}` : text
}

function completeTAdvice(result, context, payload) {
  const locked = quantity(context.lockedTodayQty)
  const sellable = quantity(context.sellableTodayQty)
  const nextDay = String(payload.nextTradeDay || '下一交易日')
  result.dir = 'none'
  result.dirLabel = '本轮做T已完成'
  result.suggestQty = 0
  result.nextSide = 'none'
  result.nextPrice = null
  result.leg1Price = null
  result.leg2Price = null
  const lockText = locked > 0
    ? `买回${locked}手今日T+1锁定，今日可卖${sellable}手`
    : `当前今日可卖${sellable}手`
  result.actionPlan = `本轮做T已完成，${lockText}；${sellable > 0 ? '今天不重复做T，按持仓计划管理剩余老仓' : `${nextDay}再按盘面决定卖出或继续持有`}`
  return result
}

export function applyTActionAdvicePolicy({
  mode,
  result: input,
  payload = {},
} = {}) {
  const result = input && typeof input === 'object' ? { ...input } : {}
  const context = payload.tContext
  if (!context || context.stage === 'idle') return result

  if (mode === 't_advice') {
    if (context.stage === 'buy_wait_sell') {
      const qty = Math.max(
        0,
        Math.min(
          quantity(context.pendingQty),
          quantity(context.sellableTodayQty),
        ),
      )
      const boughtAt = price(context.firstLegPrice)
      const sellAt = price(
        result.leg2Price
        ?? result.resistance
        ?? result.reducePrice
        ?? result.targetPrice,
      )
      if (!(qty > 0)) {
        result.dir = 'none'
        result.dirLabel = '买腿已锁定'
        result.suggestQty = 0
        result.nextSide = 'none'
        result.nextPrice = null
        result.actionPlan = `已买${quantity(context.pendingQty)}手${boughtAt ? `@${boughtAt}元` : ''}，但今日无可卖老仓；${payload.nextTradeDay || '下一交易日'}再择价卖出`
        return result
      }
      result.dir = 'positive'
      result.dirLabel = '买腿待高抛'
      result.suggestQty = qty
      result.nextSide = 'sell'
      result.nextPrice = sellAt
      result.leg1Price = boughtAt
      if (sellAt) result.leg2Price = sellAt
      result.actionPlan = `已买${quantity(context.pendingQty)}手${boughtAt ? `@${boughtAt}元` : ''}；${sellAt ? `到${sellAt}元` : '等反弹转弱'}卖出${qty}手完成做T`
      return result
    }
    if (context.stage === 'sell_wait_buy') {
      const qty = quantity(context.pendingQty)
      const soldAt = price(context.firstLegPrice)
      const buyAt = price(
        result.leg2Price
        ?? result.support
        ?? result.addPrice,
      )
      result.dir = 'reverse'
      result.dirLabel = '卖腿待接回'
      result.suggestQty = qty
      result.nextSide = 'buy'
      result.nextPrice = buyAt
      result.leg1Price = soldAt
      if (buyAt) result.leg2Price = buyAt
      result.actionPlan = `已卖${qty}手${soldAt ? `@${soldAt}元` : ''}；${buyAt ? `回落到${buyAt}元` : '等回落企稳'}接回${qty}手完成做T`
      return result
    }
    if (context.stage === 'completed' || context.stage === 'completed_locked') {
      return completeTAdvice(result, context, payload)
    }
    return result
  }

  if (mode !== 'hold_advice' && mode !== 'review') return result
  if (context.stage === 'buy_wait_sell') {
    const sellAt = price(result.reducePrice ?? result.targetPrice)
    prefixPlan(
      result,
      `做T第一腿已买${quantity(context.pendingQty)}手${context.firstLegPrice ? `@${price(context.firstLegPrice)}元` : ''}，当前应${sellAt ? `等${sellAt}元` : '等合适反弹'}卖出完成第二腿`,
      mode === 'review' ? 'nextAction' : 'actionPlan',
    )
  } else if (context.stage === 'sell_wait_buy') {
    const buyAt = price(result.addPrice)
    prefixPlan(
      result,
      `做T第一腿已卖${quantity(context.pendingQty)}手${context.firstLegPrice ? `@${price(context.firstLegPrice)}元` : ''}，当前应${buyAt ? `等${buyAt}元` : '等回落企稳'}接回完成第二腿`,
      mode === 'review' ? 'nextAction' : 'actionPlan',
    )
  } else if (context.stage === 'completed_locked') {
    const nextDay = String(payload.nextTradeDay || '下一交易日')
    const text = `本轮做T已完成，买回${quantity(context.lockedTodayQty)}手今日T+1锁定、今日可卖0手；${nextDay}再按盘面操作`
    if (mode === 'review') {
      result.stance = '持有'
      result.nextAction = text
    } else {
      result.action = '持有'
      result.actionPlan = text
    }
    result.opQty = '今日不可卖'
    result.opAmount = 0
  } else if (context.stage === 'completed') {
    const text = `本轮做T已完成，买回${quantity(context.lockedTodayQty)}手已锁定、今日仍可卖${quantity(context.sellableTodayQty)}手；后续按持仓计划操作，不重复计算本轮做T`
    prefixPlan(
      result,
      text,
      mode === 'review' ? 'nextAction' : 'actionPlan',
    )
  }
  return result
}
