import { t1GateForSide } from './t1AdvicePolicy.js'
import { humanizeUserFacingText } from './userFacingLanguage.js'
import { executionTriggerDirection } from './executionTrigger.js'
import { adviceObservationLevels } from './advicePriceContract.js'

const finite = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

const clean = (value, limit = 240) => {
  const text = humanizeUserFacingText(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

const rounded = (value, digits = 1) =>
  Number(Number(value).toFixed(digits))

const clamp = (value, low = 0, high = 100) =>
  Math.max(low, Math.min(high, value))

function quantityText(value, verb = '') {
  if (value == null || value === '') return ''
  const text = clean(value, 40)
  if (!text || /无需|不操作|不可|观望|持有\s*0|0\s*手/.test(text)) return ''
  const match = text.match(/\d+(?:\.\d+)?/)
  if (!match || !(Number(match[0]) > 0)) return ''
  if (/手/.test(text)) return text
  return `${verb}${Math.trunc(Number(match[0]))}手`
}

function actionKind(advice, mode) {
  const action = clean(advice.action || advice.stance, 80)
  if (/观望|等待|回避|不建议|暂不/.test(action)) return 'wait'
  if (/清仓|卖出|止损|离场/.test(action)) return 'sell'
  if (/减仓|止盈/.test(action)) return 'reduce'
  if (/加仓|补仓|接回|买回/.test(action)) return 'add'
  if (/持有|不动|无需操作/.test(action)) return 'hold'
  if (mode === 'buy_advice' || /买入|建仓|试错|试仓/.test(action)) return 'buy'
  return 'hold'
}

const level = (key, label, price, tone, active) => {
  const value = finite(price)
  return value == null ? null : { key, label, price: value, tone, active }
}

function priceBasisLabel(value = '') {
  const source = String(value || '')
  if (source === 'quote.current') return '当前价'
  if (source === 'quote.open') return '当日开盘价'
  if (source === 'quote.dayLow') return '当日最低价'
  if (source === 'quote.dayHigh') return '当日最高价'
  if (source === 'technical.support') return '技术支撑位'
  if (source === 'technical.resistance') return '技术压力位'
  if (source.startsWith('technical.buyZone')) return '技术买入区'
  if (source.startsWith('technical.sellZone')) return '技术卖出区'
  if (source === 'technical.stopLoss') return '技术止损位'
  if (source === 'technical.takeProfit') return '技术止盈位'
  if (source === 'intraday.vwap') return '分时均价'
  if (source === 'intraday.dayLow') return '盘中最低价'
  if (source === 'intraday.dayHigh') return '盘中最高价'
  if (source === 'quant.highConf.buyPrice') return '量化买入价'
  const movingAverage = source.match(/^technical\.ma(\d+)$/)
  if (movingAverage) return `${movingAverage[1]}日均线`
  return source ? '可核验价位' : ''
}

function withPriceBasis(levels, advice = {}) {
  const contract = advice.priceContract?.schemaVersion
    === 'advice-price-contract.v1'
    ? advice.priceContract
    : advice.decisionPlan?.priceContract?.schemaVersion
      === 'advice-price-contract.v1'
      ? advice.decisionPlan.priceContract
      : null
  return levels.map((item) => {
    const source = contract?.levels?.find((levelItem) =>
      levelItem?.key === item.key
      && Number(levelItem.price) === Number(item.price)
    )?.basis
    return source
      ? {
          ...item,
          basis: source,
          basisLabel: priceBasisLabel(source),
        }
      : item
  })
}

function deferredOpportunityView(plan, executionOpen) {
  const next = plan?.actionPolicy?.nextSessionPlan
  if (!next || !['PROBE', 'BUY'].includes(next.action)) return null
  const sessionPrefix = {
    AFTERNOON: '下午',
    OPENING: '开盘后',
    NEXT_TRADING_DAY: '次日',
  }[next.session] || '下一时段'
  const reviewActionLabel = {
    AFTERNOON: '下午盘中复核',
    OPENING: '开盘后复核',
    NEXT_TRADING_DAY: '下一交易日复核',
  }[next.session] || '下一交易时段复核'
  const actionLabel = next.action === 'PROBE'
    ? '试仓'
    : '买入'
  const maxPositionPct = Number(next.maxPositionPct)
  const quantityLabel = (
    next.action === 'PROBE'
    && Number.isFinite(maxPositionPct)
    && maxPositionPct > 0
  ) ? `仓位≤${maxPositionPct}%` : ''
  const liveReview = executionOpen === true
  return {
    action: liveReview
      ? `盘中${actionLabel}复核`
      : `${sessionPrefix}${actionLabel}预案`,
    displayTone: 'buy',
    commandLabel: '后续计划',
    reviewActionLabel: liveReview
      ? '立即复核'
      : reviewActionLabel,
    shortHorizon: liveReview
      ? '休市预案待确认'
      : '当前休市',
    quantityLabel,
    instruction: clean(
      `${next.trigger || `${next.sessionLabel || '下一交易时段盘中'}重新评估`}；盘中复核通过后人工确认，不自动下单`,
      240,
    ),
    trigger: {
      direction: 'inactive',
      price: null,
      label: '等待确认',
      stateLabel: liveReview ? '盘中先复核' : '当前休市',
      detailLabel: liveReview
        ? '先更新行情与量价'
        : '满足条件后提醒',
      metricLabel: liveReview
        ? '不自动下单'
        : `${actionLabel}预案`,
    },
  }
}

function levelsFor(kind, advice, triggerDirection = '') {
  const entryPrice = advice.buyPrice ?? advice.addPrice
  if (kind === 'wait') {
    return adviceObservationLevels(advice).map((item) => ({
      key: item.key,
      label: item.label,
      price: item.price,
      tone: item.direction === 'GTE' ? 'buy' : 'muted',
      active: false,
    }))
  }
  if (kind === 'buy') {
    return [
      level('entry', '买入价', entryPrice, 'buy', true),
      level('target', '止盈参考', advice.targetPrice, 'sell', false),
      level('stop', '止损价', advice.stopPrice, 'risk', false),
    ].filter(Boolean)
  }
  if (kind === 'add') {
    return [
      level('add', '加仓执行价', advice.addPrice ?? advice.buyPrice, 'buy', true),
      level('reduce', '减仓参考', advice.reducePrice ?? advice.targetPrice, 'sell', false),
      level('stop', '止损价', advice.stopPrice, 'risk', false),
    ].filter(Boolean)
  }
  if (kind === 'reduce') {
    return [
      level(
        'reduce',
        triggerDirection === 'LTE'
          ? '减仓触发线'
          : triggerDirection === 'IMMEDIATE'
            ? '当前减仓参考价'
            : '反弹减仓位',
        advice.reducePrice ?? advice.targetPrice,
        'sell',
        true,
      ),
      level('stop', '止损价', advice.stopPrice, 'risk', false),
    ].filter(Boolean)
  }
  if (kind === 'sell') {
    const stop = level('stop', '退出执行价', advice.stopPrice, 'risk', true)
    const reduce = level('reduce', '卖出执行价', advice.reducePrice, 'sell', !stop)
    return [
      stop,
      reduce,
      level('target', '目标参考', advice.targetPrice, 'sell', false),
    ].filter(Boolean)
  }
  return [
    level('add', '回踩观察', advice.addPrice ?? advice.buyPrice, 'buy', false),
    level('reduce', '反弹观察', advice.reducePrice ?? advice.targetPrice, 'sell', false),
    level('stop', '止损价', advice.stopPrice, 'risk', false),
  ].filter(Boolean)
}

function triggerFor(kind, levels, triggerDirection = '') {
  const primary = levels.find((item) => item.active)
  if (kind === 'wait') {
    return {
      direction: 'inactive',
      price: primary?.price ?? null,
      label: '等待确认',
      stateLabel: '保持观望',
      detailLabel: '等待量价确认',
      metricLabel: '暂不下单',
    }
  }
  if (kind === 'buy' || kind === 'add') {
    return primary ? {
      direction: 'lte',
      price: primary.price,
      label: kind === 'add' ? '加仓位' : '买入位',
      metricLabel: kind === 'add' ? '加仓准备' : '买入准备',
    } : null
  }
  if (kind === 'reduce') {
    return primary ? {
      direction: triggerDirection.toLowerCase() || 'gte',
      price: primary.price,
      label: triggerDirection === 'LTE' ? '减仓线' : '减仓位',
      metricLabel: triggerDirection === 'LTE' ? '减仓条件' : '减仓准备',
    } : null
  }
  if (kind === 'sell') {
    return primary ? {
      direction: primary.key === 'stop' ? 'lte' : 'gte',
      price: primary.price,
      label: '退出位',
      metricLabel: '退出准备',
    } : null
  }
  const low = levels.find((item) => item.key === 'add')?.price
    ?? levels.find((item) => item.key === 'stop')?.price
  const high = levels.find((item) => item.key === 'reduce')?.price
  if (low != null && high != null && high > low) {
    return {
      direction: 'range',
      low,
      high,
      label: '观察区间',
      metricLabel: '继续持有',
    }
  }
  return null
}

export function buildAdviceActionView(
  advice = {},
  {
    mode = '',
    currentPrice = null,
    executionOpen = null,
  } = {},
) {
  const plan = advice.decisionPlan?.schemaVersion === 'decision-plan.v2'
    ? advice.decisionPlan
    : null
  const planAction = {
    BUY: '买入',
    ADD: '加仓',
    HOLD: '持有',
    REDUCE: '减仓',
    EXIT: '清仓',
    T_BUY_FIRST: '买回',
    T_SELL_FIRST: '减仓',
    WATCH: '观望',
  }[plan?.action]
  const planReasons = (Array.isArray(plan?.blockedReasons)
    ? plan.blockedReasons
    : []).map((item) => clean(item, 160)).filter(Boolean)
  const planLots = Number(plan?.quantity?.lots) || 0
  const planPrice = finite(plan?.prices?.reference)
  const manualProbe = plan?.actionability === 'MANUAL_PROBE'
    || plan?.manualConfirmationOnly === true
  const planInstruction = plan?.actionability === 'BLOCKED'
    ? `暂不执行：${planReasons.join('；') || '执行条件未满足'}`
    : manualProbe
      ? `人工确认：${plan?.action === 'ADD' ? '小仓加仓' : '小仓试错'}${planLots}手${planPrice != null ? `，参考${planPrice}元` : ''}${plan.opportunity?.sectorName ? `；${plan.opportunity.sectorName}前排` : ''}，板块与个股条件失效时取消`
    : plan?.actionability === 'RESEARCH_ONLY'
      ? `仅供观察：${planAction || '操作'}${planLots}手${planPrice != null ? `，参考${planPrice}元` : ''}；策略通过实盘启用审核前，不能直接执行`
      : ''
  const source = plan ? {
    ...advice,
    action: plan.actionability === 'BLOCKED'
      ? '观望'
      : manualProbe
        ? plan.action === 'ADD' ? '小仓加仓' : '小仓试错'
      : plan.actionability === 'RESEARCH_ONLY'
        ? `观察·${planAction || '建议'}`
        : planAction || advice.action,
    actionPlan: planInstruction || advice.actionPlan,
    planQty: plan.quantity?.lots,
    planQtyNum: plan.quantity?.lots,
    opQty: plan.action === 'BUY'
      ? advice.opQty
      : plan.quantity?.lots > 0
        ? `${planAction || '操作'}${plan.quantity.lots}手`
        : '无需操作',
    buyPrice: plan.action === 'BUY'
      ? plan.prices?.reference
      : advice.buyPrice,
    addPrice: plan.action === 'ADD'
      ? plan.prices?.reference
      : advice.addPrice,
    reducePrice: ['REDUCE', 'EXIT', 'T_SELL_FIRST'].includes(plan.action)
      ? plan.prices?.reference
      : advice.reducePrice,
    stopPrice: plan.prices?.stop,
    targetPrice: plan.prices?.target,
  } : advice
  const kind = actionKind(source, mode)
  const buySide = kind === 'buy'
  const quantity = buySide
    ? quantityText(source.planQtyNum ?? source.planQty)
    : quantityText(source.opQty)
  const action = clean(source.action || source.stance, 80)
  const instruction = clean(
    plan?.actionability === 'BLOCKED'
      ? (plan.blockedReasons || []).join('；')
      : source.actionPlan
        || source.nextAction
        || source.title
        || source.headline
        || source.timing
        || source.reason,
  )
  const triggerDirection = executionTriggerDirection({
    action: plan?.action || {
      buy: 'BUY',
      add: 'ADD',
      reduce: 'REDUCE',
      sell: 'EXIT',
    }[kind],
    trigger: instruction,
    triggerDirection: plan?.triggerDirection,
  })
  const levels = withPriceBasis(
    levelsFor(kind, source, triggerDirection),
    source,
  )
  const current = finite(currentPrice)
  const entry = levels.find((item) =>
    item.key === 'entry'
    && item.active
  )
  const entryAboveCurrent = (
    mode === 'buy_advice'
    && kind === 'buy'
    && current != null
    && entry?.price > current
  )
  const generatedOutsideSession = (
    plan?.actionPolicy?.executionOpen === false
    || plan?.evidenceBasis?.isLive === false
  )
  const sessionDeferred = (
    mode === 'buy_advice'
    && kind === 'buy'
    && (
      executionOpen === false
      || generatedOutsideSession
    )
  )
  const deferredOpportunity = sessionDeferred
    ? deferredOpportunityView(plan, executionOpen)
    : null
  if (entry && (entryAboveCurrent || sessionDeferred)) {
    const observationKey = entryAboveCurrent
      ? 'watch_breakout'
      : 'watch_pullback'
    const observationLabel = entryAboveCurrent
      ? '突破观察'
      : '回踩观察'
    const phasePrefix = executionOpen === false
      ? '当前休市，下一交易时段盘中'
      : generatedOutsideSession
        ? '当前建议基于休市快照，盘中先复核'
        : '盘中'
    const reason = entryAboveCurrent
      ? `${entry.price}元高于${sessionDeferred ? '收盘价' : '现价'}${current}元，只作突破观察，不是买入价`
      : `${entry.price}元只作回踩观察，当前不执行`
    return {
      kind: 'wait',
      action: deferredOpportunity?.action
        || (sessionDeferred ? '等待盘中' : '等待突破'),
      displayTone: deferredOpportunity?.displayTone,
      commandLabel: deferredOpportunity?.commandLabel,
      reviewActionLabel:
        deferredOpportunity?.reviewActionLabel,
      shortHorizon: deferredOpportunity?.shortHorizon
        || clean(source.shortHorizon, 30),
      instruction: deferredOpportunity
        ? clean(
            `${deferredOpportunity.instruction}；${reason}`,
            240,
          )
        : `${phasePrefix}：${reason}；满足后重新生成建议`,
      quantity: '',
      quantityLabel: deferredOpportunity?.quantityLabel,
      levels: [{
        ...entry,
        key: observationKey,
        label: observationLabel,
        active: false,
      }],
      trigger: deferredOpportunity?.trigger || {
        direction: 'inactive',
        price: null,
        label: '等待确认',
        stateLabel: sessionDeferred ? '等待下一交易时段' : '等待突破确认',
        detailLabel: '盘中满足条件后再提醒',
        metricLabel: '当前不下单',
      },
      actionability: 'WATCH',
      manualOnly: !!deferredOpportunity,
      actionable: false,
      deferred: true,
      deferredReason: reason,
    }
  }
  const deferredWait = (
    mode === 'buy_advice'
    && kind === 'wait'
    && (
      executionOpen === false
      || (
        generatedOutsideSession
        && plan?.actionPolicy?.nextSessionPlan
      )
    )
  )
  const deferredWaitPlan = deferredWait
    ? deferredOpportunityView(plan, executionOpen)
    : null
  return {
    kind,
    action: deferredWaitPlan?.action
      || (deferredWait ? '等待盘中' : action || ({
      buy: '买入',
      add: '加仓',
      reduce: '减仓',
      sell: '退出',
      hold: '持有',
      wait: '观望',
    }[kind])),
    displayTone: deferredWaitPlan?.displayTone,
    commandLabel: deferredWaitPlan?.commandLabel,
    reviewActionLabel: deferredWaitPlan?.reviewActionLabel,
    shortHorizon: deferredWaitPlan?.shortHorizon
      || clean(source.shortHorizon, 30),
    instruction: deferredWaitPlan?.instruction || instruction,
    quantity,
    quantityLabel: deferredWaitPlan?.quantityLabel,
    levels,
    trigger: deferredWaitPlan?.trigger || (deferredWait
      ? {
          direction: 'inactive',
          price: null,
          label: '等待确认',
          stateLabel: '等待下一交易时段',
          detailLabel: '盘中满足条件后再提醒',
          metricLabel: '当前不下单',
        }
      : triggerFor(kind, levels, triggerDirection)),
    actionability: plan?.actionability || null,
    manualOnly: deferredWaitPlan
      ? true
      : manualProbe,
    actionable: plan
      ? ['READY', 'MANUAL_PROBE'].includes(plan.actionability)
      : !['wait', 'hold'].includes(kind),
    deferred: deferredWait,
    deferredReason: deferredWait
      ? '当前不在连续竞价时段'
      : '',
  }
}

function holdingPriceText(value) {
  const number = finite(value)
  if (number == null) return '计划价'
  return String(number < 10 ? +number.toFixed(3) : +number.toFixed(2))
}

export function buildHoldingCardDecisionView({
  advice = null,
  hitTarget = false,
  hitStop = false,
  targetPrice = null,
  stopPrice = null,
  t1Status = null,
  nextTradeDay = '',
} = {}) {
  const source = advice && typeof advice === 'object' ? advice : {}
  const exitSide = hitStop ? 'stop' : hitTarget ? 'sell' : ''
  const gate = exitSide && t1Status
    ? t1GateForSide(exitSide, t1Status, nextTradeDay)
    : null
  const existingPlan = clean(source.actionPlan || source.nextAction)
  const persistedExitBlocked = /今日不可卖|T\+1锁定/.test(
    `${clean(source.opQty, 80)} ${existingPlan}`,
  )

  if (gate?.blocked || persistedExitBlocked) {
    const reached = hitStop
      ? `止损参考${holdingPriceText(stopPrice)}已触及`
      : `止盈参考${holdingPriceText(targetPrice)}已触及`
    const instruction = persistedExitBlocked && existingPlan
      ? existingPlan
      : `${reached}，但${gate?.reason || '今日买入仓位受T+1锁定，今日不可卖'}；${nextTradeDay || '下一交易日'}再按盘面操作`
    return buildAdviceActionView({
      ...source,
      action: '持有',
      stance: '持有',
      opQty: '今日不可卖',
      actionPlan: instruction,
      reducePrice: source.reducePrice ?? targetPrice,
      stopPrice: source.stopPrice ?? stopPrice,
      targetPrice: source.targetPrice ?? targetPrice,
    }, { mode: 'hold_advice' })
  }

  if (hitTarget) {
    return buildAdviceActionView({
      action: '止盈',
      actionPlan: `现价已到止盈参考 ${holdingPriceText(targetPrice)}，按确认信号分批落袋`,
      reducePrice: targetPrice,
      stopPrice,
    }, { mode: 'hold_advice' })
  }
  if (hitStop) {
    return buildAdviceActionView({
      action: '止损',
      actionPlan: `现价已到止损参考 ${holdingPriceText(stopPrice)}，按纪律确认后退出`,
      stopPrice,
      targetPrice,
    }, { mode: 'hold_advice' })
  }
  return advice
    ? buildAdviceActionView(advice, { mode: 'hold_advice' })
    : null
}

export function buildActionProgress(trigger, currentPrice) {
  const current = finite(currentPrice)
  if (!trigger || current == null || trigger.direction === 'inactive') return null

  if (trigger.direction === 'range') {
    const low = finite(trigger.low)
    const high = finite(trigger.high)
    if (low == null || high == null || !(high > low)) return null
    if (current < low) {
      const distance = (low - current) / low * 100
      return {
        pct: 0,
        score: 0,
        tone: 'risk',
        label: `低于回踩位 ${distance.toFixed(1)}%`,
        metricLabel: trigger.metricLabel,
        stateLabel: '已到回踩位',
        reached: true,
        currentPrice: current,
      }
    }
    if (current > high) {
      const distance = (current - high) / high * 100
      return {
        pct: 100,
        score: 100,
        tone: 'sell',
        label: `高于反弹位 ${distance.toFixed(1)}%`,
        metricLabel: trigger.metricLabel,
        stateLabel: '已到反弹位',
        reached: true,
        currentPrice: current,
      }
    }
    const position = clamp((current - low) / (high - low) * 100)
    return {
      pct: rounded(position),
      score: rounded(position),
      tone: 'range',
      label: position < 34
        ? '现价靠近回踩位'
        : position > 66
          ? '现价靠近反弹位'
          : '现价位于区间中部',
      metricLabel: trigger.metricLabel,
      stateLabel: '区间内持有',
      reached: false,
      currentPrice: current,
    }
  }

  const target = finite(trigger.price)
  if (target == null) return null
  if (trigger.direction === 'immediate') {
    return {
      pct: 100,
      score: 100,
      tone: 'sell',
      label: '当前可按计划处理',
      metricLabel: trigger.metricLabel,
      stateLabel: '现在可处理',
      reached: true,
      currentPrice: current,
    }
  }
  const distance = trigger.direction === 'gte'
    ? (target - current) / target * 100
    : (current - target) / target * 100

  if (distance > 0) {
    const score = clamp(100 - distance / 8 * 100)
    return {
      pct: rounded(score),
      score: rounded(score),
      tone: trigger.direction === 'gte' ? 'sell' : 'buy',
      label: `距${trigger.label} ${distance.toFixed(1)}%`,
      metricLabel: trigger.metricLabel,
      stateLabel: score >= 75
        ? `接近${trigger.label}`
        : trigger.direction === 'gte'
          ? '等待反弹'
          : trigger.metricLabel === '减仓条件'
            ? '等待跌破'
            : '等待回踩',
      reached: false,
      currentPrice: current,
    }
  }

  const crossed = Math.abs(distance)
  if (trigger.direction === 'lte' && crossed > 5) {
    const score = clamp(60 - (crossed - 5) * 10)
    return {
      pct: rounded(score),
      score: rounded(score),
      tone: 'risk',
      label: `跌穿${trigger.label} ${crossed.toFixed(1)}% · 需复核`,
      metricLabel: trigger.metricLabel,
      stateLabel: `已跌破${trigger.label}`,
      reached: true,
      currentPrice: current,
    }
  }
  return {
    pct: 100,
    score: 100,
    tone: trigger.direction === 'gte' ? 'sell' : 'buy',
    label: `已到${trigger.label} · 等确认`,
    metricLabel: trigger.metricLabel,
    stateLabel: `已到${trigger.label}`,
    reached: true,
    currentPrice: current,
  }
}
