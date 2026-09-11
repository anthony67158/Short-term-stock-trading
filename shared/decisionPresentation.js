import {
  isDecisionEngineAdvice,
} from './decisionEngineSource.js'
import { isContinuousTrading } from './tradingCalendar.js'
import { humanizeUserFacingText } from './userFacingLanguage.js'

const finite = (value) => value != null && value !== '' && Number.isFinite(Number(value))
const priceText = (value) => finite(value) && Number(value) > 0 ? `${Number(value)}元` : '暂无'

export function decisionPrices(advice = {}) {
  if (!isDecisionEngineAdvice(advice)) return []
  const plan = advice.decisionPlan || {}
  const prices = plan.prices || {}
  const observations = (
    plan.mode !== 'hold_advice'
    || advice.holdingAddPlan?.schemaVersion === 'holding-add-plan.v1'
  ) && Array.isArray(prices.observations)
    ? prices.observations
    : []
  const observationByKey = new Map(
    observations.map((item) => [String(item?.key || ''), item]),
  )
  const candidates = [
    {
      key: 'watch_pullback',
      label: '回踩观察',
      value: observationByKey.get('watch_pullback')?.price
        ?? advice.pullbackWatchPrice,
      tone: 'watch',
    },
    {
      key: 'watch_breakout',
      label: '突破观察',
      value: observationByKey.get('watch_breakout')?.price
        ?? advice.breakoutWatchPrice,
      tone: 'watch',
    },
    {
      key: 'reference',
      label: {
        BUY: '买入参考',
        ADD: '加仓参考',
        REDUCE: '减仓参考',
        EXIT: '退出参考',
      }[plan.action],
      value: ['BUY', 'ADD', 'REDUCE', 'EXIT'].includes(plan.action)
        ? prices.reference
        : null,
      tone: ['REDUCE', 'EXIT'].includes(plan.action) ? 'risk' : 'action',
    },
    {
      key: 'stop',
      label: '止损',
      value: prices.stop ?? advice.stopPrice,
      tone: 'risk',
    },
    {
      key: 'target',
      label: '目标',
      value: prices.target ?? advice.targetPrice,
      tone: 'target',
    },
  ]
  return candidates
    .filter((item) =>
      item.label
      && finite(item.value)
      && Number(item.value) > 0
    )
    .map((item) => ({ ...item, value: Number(item.value) }))
}

export function decisionPresentation({
  advice, holdingLots = 0, stopPrice = null, managed = true,
  loading = false, now = Date.now(), currentPrice,
  sellableLots = null, executionPlans = [],
} = {}) {
  const held = Number(holdingLots) > 0
  const source = advice?.decisionSource
  const isDecisionEngine = isDecisionEngineAdvice(advice)
  const plan = isDecisionEngine ? advice?.decisionPlan : null
  const expiresAt = Date.parse(plan?.validUntil)
  const expired = Number.isFinite(expiresAt) && expiresAt <= now
  const completed = executionPlans.some((item) => item.decisionId === plan?.decisionId
    && item.decisionId && ['COMPLETED', 'CANCELED', 'EXPIRED'].includes(item.status))
  const active = isDecisionEngine
    && Number.isFinite(expiresAt)
    && !expired
    && !completed
  const ready = active && source.state === 'READY'
  const stop = held ? stopPrice ?? advice?.stopPrice : advice?.stopPrice
  const live = isContinuousTrading(now) && (currentPrice === undefined || Number(currentPrice) > 0)
  const hardStop = held && live && Number(currentPrice) > 0
    && Number(stop) > 0 && Number(currentPrice) <= Number(stop)
  const sellable = sellableLots == null ? null
    : Math.max(0, Math.min(Number(holdingLots), Math.trunc(Number(sellableLots) || 0)))
  let action = hardStop
    ? sellable >= holdingLots ? 'EXIT' : 'REDUCE'
    : plan?.action || (held ? 'HOLD' : 'WATCH')
  const selling = ['EXIT', 'REDUCE'].includes(action)
  const buying = ['BUY', 'ADD'].includes(action)
  const exitReviewRequired = (
    selling
    && !hardStop
    && source?.hardProtection !== true
    && source?.exitReviewRequired !== false
    && advice?.reviewDecision?.terminal !== true
  )
  const plannedQty = Math.max(0, Math.trunc(Number(plan?.quantity?.lots) || 0))
  const qty = hardStop ? sellable || 0
    : selling && sellable != null ? Math.min(plannedQty, sellable) : plannedQty
  const referencePrice = hardStop ? Number(currentPrice) : plan?.prices?.reference
  const priceMoved = buying && Number(currentPrice) > 0 && Number(referencePrice) > 0
    && Math.abs(Number(currentPrice) / Number(referencePrice) - 1) > 0.015
  const executable = hardStop ? qty > 0 : managed && !loading && active
    && (ready || (selling && source?.hardProtection === true))
    && (selling || buying) && plan?.actionability === 'READY'
    && qty > 0 && live && !priceMoved && !exitReviewRequired
  const trigger = advice?.pullbackWatchPrice ?? advice?.breakoutWatchPrice
  const waiting = ready && !held && finite(trigger) && Number(trigger) > 0
  const addWaiting = (
    ready
    && held
    && advice?.holdingAddPlan?.schemaVersion === 'holding-add-plan.v1'
    && finite(trigger)
    && Number(trigger) > 0
  )
  let headline = held ? `继续持有 ${holdingLots} 手` : '本次不买入'
  let reason = ''
  let timing = '条件变化时重新评估'
  let tone = 'neutral'
  let icon = held ? 'shield' : 'clock'
  if (hardStop) {
    headline = qty > 0 ? `${action === 'EXIT' ? '清仓' : '减仓'} ${qty} 手` : '触及止损，今日不可卖'
    reason = qty > 0 ? `现价已到止损${priceText(stop)}，先处理可卖仓位。`
      : '今日买入受T+1限制，下一可卖时段优先处理。'
    timing = qty > 0 ? '当前交易时段' : '下一可卖交易时段'
    tone = 'exit'
    icon = 'sell'
  } else if (!managed) {
    headline = '仅收藏，尚未跟踪'
    reason = '纳入作战后，才会评估买点并跟踪条件。'
    timing = '尚未启用'
  } else if (loading) {
    headline = '正在更新决策'
    reason = '核对行情、决策模型结果和账户约束。'
    timing = '计算完成后更新'
  } else if (!active) {
    headline = held ? '暂不加仓' : '暂不买入'
    reason = completed ? '本轮指令已结束，请更新后再操作。'
      : expired ? '上一决策已过期，请更新后再操作。'
      : '尚无本轮系统决策，请先更新。'
    timing = '更新决策后'
  } else if (executable) {
    headline = `${{ EXIT: '清仓', REDUCE: '减仓', BUY: '买入', ADD: '加仓' }[action]} ${qty} 手`
    reason = selling ? '在券商端完成卖出，再记录实际成交。'
      : '核对参考价和可用资金，在券商端成交后记录。'
    timing = '当前交易时段'
    tone = selling ? 'exit' : 'buy'
    icon = selling ? 'sell' : 'cart'
  } else if (source.hardProtection) {
    headline = held ? '已触及止损' : '本次不买入'
    reason = advice.actionPlan || '优先处理可卖仓位。'
    timing = isContinuousTrading(now) ? '按今日可卖数量处理' : '下一可卖交易时段'
    tone = 'exit'
  } else if (!ready) {
    headline = held ? '暂不加仓' : '暂不买入'
    reason = source.state === 'EVIDENCE_INCOMPLETE'
      ? `缺少${source.missingEvidence?.join('、') || '行情或资金数据'}，尚不能确认新操作。`
      : '本轮未获得有效决策模型结果，请更新后重试；未使用旧结论替代。'
    timing = '数据恢复后重新评估'
  } else if (
    exitReviewRequired
  ) {
    headline = '等待退出前复核'
    reason = '这不是硬止损。系统先观察约60秒，再按最新价格、资金和决策模型结果决定是否卖出。'
    timing = '下一笔有效报价开始观察'
    icon = 'clock'
  } else if (plan.blockedReasons?.length) {
    headline = held ? '本次不加仓' : '本次不买入'
    reason = humanizeUserFacingText(plan.blockedReasons.join('；'))
  } else if (advice.adaptiveAction?.selected?.action === 'HOLD_LOCKED') {
    headline = '等待可卖时段退出'
    reason = '当前路径费后价值不为正，但今日仓位受T+1锁定。'
    timing = '下一可卖交易时段'
  } else if (priceMoved) {
    headline = held ? '暂不加仓' : '暂不买入'
    reason = `现价已偏离参考价${priceText(referencePrice)}，请更新决策。`
    timing = '更新决策后'
  } else if (addWaiting) {
    headline = `继续持有 ${holdingLots} 手`
    reason = `当前不加仓；等待${
      advice.holdingAddPlan.route === 'PULLBACK' ? '回踩' : '突破'
    } ${priceText(trigger)}后由系统重新评估加仓。`
    timing = '加仓观察价触发后'
    tone = 'wait'
    icon = 'clock'
  } else if (waiting) {
    headline = `等待${advice.pullbackWatchPrice ? '回踩' : '突破'} ${priceText(trigger)}`
    reason = '现在不下单；到价后由系统重新评估并提醒。'
    timing = '条件触发后'
  } else if (selling || buying) {
    headline = selling ? `待卖出 ${qty} 手` : `待买入 ${qty} 手`
    reason = '当前不可执行，下一交易时段重新核对价格。'
    timing = '下一交易时段'
  } else {
    reason = held ? '当前路径价值仍为正，本次不加仓、不减仓。'
      : '当前没有费后价值为正的买入路径。'
  }
  return {
    headline, reason, timing, tone, icon, executable, action, qty,
    isDecisionEngine, ready, waiting, hardStop, exitReviewRequired,
    addWaiting,
    kind: { BUY: 'buy', ADD: 'add', EXIT: 'sell', REDUCE: 'reduce', HOLD: 'hold', WATCH: 'wait' }[action],
    actionable: executable,
    quantity: executable ? `${qty}手` : '',
    levels: executable ? [{ key: selling ? 'reduce' : 'entry', price: referencePrice, active: true }] : [],
    reference: priceText(referencePrice),
    stop: priceText(stop),
    target: priceText(advice?.targetPrice),
    protection: held
      ? Number(stop) > 0 ? `跌至 ${priceText(stop)} 优先处理风险` : '尚未设置保护价'
      : Number(stop) > 0 && ready ? `成交后以 ${priceText(stop)} 为风险边界` : '未建仓，不承担该股持仓风险',
  }
}
