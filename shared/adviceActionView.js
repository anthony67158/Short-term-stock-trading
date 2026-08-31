import { t1GateForSide } from './t1AdvicePolicy.js'
import {
  explicitActionInstruction,
  explicitActionLabel,
  humanizeUserFacingText,
} from './userFacingLanguage.js'
import { executionTriggerDirection } from './executionTrigger.js'
import { adviceObservationLevels } from './advicePriceContract.js'
import { holdingAddReviewPlan } from './holdingFollowUp.js'

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

export function actionImportance(view = {}) {
  const action = clean(view.action, 80)
  if (/止损|清仓|退出/.test(action)) return 'critical'
  if (
    view.deferred
    || view.manualOnly
    || view.trigger?.direction === 'inactive'
  ) {
    if (/试仓/.test(action)) return 'conditional'
    if (/条件(?:买入|加仓)|(?:待确认|人工确认后)建仓/.test(action)) {
      return 'ready'
    }
    return 'watch'
  }
  if (['buy', 'add', 'reduce', 'sell'].includes(view.kind)) {
    return 'execute'
  }
  if (view.kind === 'hold') return 'steady'
  return 'watch'
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
  const policy = plan?.actionPolicy || {}
  const nextSession = policy.nextSessionPlan
  const entryIntent = policy.entryIntent
  const next = nextSession || (
    entryIntent?.reviewMode === 'ENTRY_CONFIRMATION'
    && entryIntent?.directionApproved === true
      ? entryIntent
      : null
  )
  if (
    !next
    || !['PROBE', 'BUY', 'PROBE_ADD', 'ADD'].includes(
      next.action,
    )
  ) return null
  const sessionPrefix = {
    AFTERNOON: '下午',
    OPENING: '开盘后',
    NEXT_TRADING_DAY: '次日',
  }[nextSession?.session] || '盘中'
  const detailActionLabel = {
    AFTERNOON: '查看下午预案',
    OPENING: '查看开盘预案',
    NEXT_TRADING_DAY: '查看次日预案',
  }[nextSession?.session] || '查看条件计划'
  const addSide = ['PROBE_ADD', 'ADD'].includes(next.action)
  const actionLabel = addSide
    ? '条件加仓'
    : next.action === 'PROBE'
      ? '条件试仓'
      : '条件买入'
  const maxPositionPct = Number(next.maxPositionPct)
  const quantityLabel = (
    ['PROBE', 'PROBE_ADD'].includes(next.action)
    && Number.isFinite(maxPositionPct)
    && maxPositionPct > 0
  ) ? `仓位≤${maxPositionPct}%` : ''
  const liveReview = executionOpen === true
  const subject = addSide ? '加仓方向' : '买入方向'
  const outcome = addSide
    ? '具体加仓价和手数'
    : '具体买入价和手数'
  const reviewTrigger = next.trigger
    || `${next.sessionLabel || '下一交易时段盘中'}确认入场时机`
  return {
    action: liveReview ? `盘中${actionLabel}` : `${sessionPrefix}${actionLabel}`,
    displayTone: 'buy',
    commandLabel: '条件计划',
    detailActionLabel: liveReview
      ? '查看确认条件'
      : detailActionLabel,
    shortHorizon: liveReview
      ? '方向已通过 · 待时机确认'
      : '当前休市 · 方向已通过',
    quantityLabel,
    cardInstruction: clean(reviewTrigger, 120),
    instruction: clean(
      `${subject}已通过；${reviewTrigger}；确认通过后给出${outcome}${quantityLabel ? `，${quantityLabel}` : ''}，由你人工确认`,
      240,
    ),
    trigger: {
      direction: 'inactive',
      price: null,
      label: '待核对入场时机',
      stateLabel: liveReview
        ? next.action === 'PROBE'
          ? '试仓条件待复核'
          : '买入条件待复核'
        : '当前休市',
      detailLabel: liveReview
        ? '仅确认入场时机'
        : addSide ? '到价后确认加仓点' : '到价后确认买点',
      metricLabel: liveReview
        ? `确认后给${addSide ? '加仓' : '买入'}价`
        : actionLabel,
    },
  }
}

function levelsFor(kind, advice, triggerDirection = '', followUp = null) {
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
  const followUpLevels = (followUp?.paths || []).map((path) => ({
    key: path.key,
    label: path.label,
    price: path.price,
    tone: 'buy',
    active: false,
    reviewDirection: path.direction,
  }))
  return [
    ...(
      followUpLevels.length
        ? followUpLevels
        : [level(
            'add',
            '回踩加仓观察',
            advice.addPrice ?? advice.buyPrice,
            'buy',
            false,
          )].filter(Boolean)
    ),
    level(
      'reduce',
      '反弹减仓观察',
      advice.reducePrice ?? advice.targetPrice,
      'sell',
      false,
    ),
    level('stop', '止损价', advice.stopPrice, 'risk', false),
  ].filter(Boolean)
}

function preferredWaitLevel(levels = [], advice = {}, currentPrice = null) {
  const pullback = levels.find((item) => item.key === 'watch_pullback')
  const breakout = levels.find((item) => item.key === 'watch_breakout')
  const timingState = String(
    advice.shortHorizonTactical?.timing?.state || '',
  )
  if (timingState === 'WAIT_BREAKOUT' && breakout) return breakout
  if (timingState === 'WAIT_PULLBACK' && pullback) return pullback

  const instruction = String(
    advice.actionPlan || advice.timing || advice.reason || '',
  )
  const mentionsBreakout = /突破|站上|站稳/.test(instruction)
  const mentionsPullback = /回踩|回调|低吸/.test(instruction)
  if (mentionsBreakout && !mentionsPullback && breakout) return breakout
  if (mentionsPullback && !mentionsBreakout && pullback) return pullback

  const current = finite(currentPrice)
  if (current != null && pullback && breakout) {
    const pullbackDistance = Math.abs(current - pullback.price) / current
    const breakoutDistance = Math.abs(current - breakout.price) / current
    return breakoutDistance <= pullbackDistance ? breakout : pullback
  }
  return breakout || pullback || levels[0] || null
}

function waitPathInstruction(level, quantity = '') {
  if (!level) return ''
  const nextAction = quantity
    ? `复核通过后手动买入${quantity}`
    : '复核通过后按新指令的价格和手数手动买入'
  if (level.key === 'watch_breakout') {
    return `当前不买；只看${level.price}元：盘中放量站稳后立即复核一次，${nextAction}；未放量或跌回${level.price}元下方不买`
  }
  return `当前不买；只看${level.price}元：回踩不破并重新站回分时均价后立即复核一次，${nextAction}；跌破${level.price}元不买`
}

function pendingManualEntryProposal({
  advice = {},
  instruction = '',
  mode = '',
  plan = null,
} = {}) {
  if (
    mode !== 'buy_advice'
    || plan?.actionability === 'BLOCKED'
  ) return null
  const buyPrice = finite(advice.buyPrice)
  const quantity = quantityText(
    advice.planQtyNum ?? advice.planQty ?? advice.opQty,
  )
  const explicitlyPlansEntry = (
    /人工确认.*(?:买入|建仓|试仓)/.test(instruction)
    || /(?:买入|建仓|试仓).*\d+(?:\.\d+)?\s*手/.test(instruction)
  )
  if (buyPrice == null || !quantity || !explicitlyPlansEntry) return null
  return {
    buyPrice,
    quantity,
    stopPrice: finite(advice.stopPrice),
    targetPrice: finite(advice.targetPrice),
  }
}

function triggerFor(kind, levels, triggerDirection = '', followUp = null) {
  const primary = levels.find((item) => item.active)
  if (kind === 'wait') {
    const waitLevel = levels[0] || null
    return {
      direction: 'inactive',
      price: waitLevel?.price ?? null,
      label: waitLevel?.key === 'watch_breakout'
        ? '突破后再判断'
        : waitLevel?.key === 'watch_pullback'
          ? '回踩后再判断'
          : '条件尚未确认',
      stateLabel: waitLevel?.key === 'watch_breakout'
        ? '放量突破后再判断'
        : waitLevel?.key === 'watch_pullback'
          ? '回踩企稳后再判断'
          : '量价条件尚未满足',
      detailLabel: waitLevel
        ? '到价立即复核一次'
        : '出现新证据后重新评估',
      metricLabel: '未触发不买',
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
  if (followUp?.paths?.length) {
    return {
      direction: 'review_paths',
      paths: followUp.paths,
      label: '加仓复核',
      metricLabel: followUp.status === 'ENTRY_CONFIRMATION'
        ? '等待加仓确认'
        : '本轮不直接加仓',
    }
  }
  const lowLevel = levels.find((item) => item.key === 'add')
    ?? levels.find((item) => item.key === 'stop')
  const highLevel = levels.find((item) => item.key === 'reduce')
  const low = lowLevel?.price
  const high = highLevel?.price
  if (low != null && high != null && high > low) {
    return {
      direction: 'range',
      low,
      high,
      lowKey: lowLevel.key,
      highKey: highLevel.key,
      lowLabel: lowLevel.key === 'stop' ? '止损位' : '加仓观察位',
      highLabel: '减仓观察位',
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
  const terminalOutcome = advice.reviewDecision?.terminal === true
    ? clean(advice.reviewDecision.outcome, 30)
    : ''
  const holdingMode = mode === 'hold_advice'
  const planAction = {
    BUY: '现在买入',
    ADD: '加仓',
    HOLD: '继续持有',
    REDUCE: '减仓',
    EXIT: '清仓',
    T_BUY_FIRST: '买回',
    T_SELL_FIRST: '减仓',
    WATCH: holdingMode ? '持有' : '观望',
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
      ? holdingMode ? '持有' : '观望'
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
  } : (
    holdingMode
    && /观望|等待|回避|不建议|暂不/.test(
      `${advice.action || ''} ${advice.stance || ''}`,
    )
      ? { ...advice, action: '持有', stance: '持有' }
      : advice
  )
  const kind = actionKind(source, mode)
  const followUp = kind === 'hold'
    ? holdingAddReviewPlan(source)
    : null
  const buySide = kind === 'buy'
  const quantity = buySide
    ? quantityText(source.planQtyNum ?? source.planQty)
    : quantityText(source.opQty)
  const action = clean(source.action || source.stance, 80)
  const baseInstruction = clean(
    plan?.actionability === 'BLOCKED'
      ? (plan.blockedReasons || []).join('；')
      : source.actionPlan
        || source.nextAction
        || source.title
        || source.headline
        || source.timing
        || source.reason,
  )
  const initialInstruction = clean(
    followUp?.summary
      ? `${baseInstruction}${baseInstruction ? '；' : ''}${followUp.summary}`
      : baseInstruction,
  )
  const current = finite(currentPrice)
  const policyOpportunity = deferredOpportunityView(
    plan,
    executionOpen,
  )
  const pendingEntry = kind === 'wait' && !policyOpportunity
    ? pendingManualEntryProposal({
        advice,
        instruction: initialInstruction,
        mode,
        plan,
      })
    : null
  if (pendingEntry) {
    const proposalLevels = withPriceBasis([
      level('entry', '拟买价', pendingEntry.buyPrice, 'buy', false),
      level('stop', '止损价', pendingEntry.stopPrice, 'risk', false),
      level('target', '目标价', pendingEntry.targetPrice, 'sell', false),
    ].filter(Boolean), advice)
    return {
      kind: 'wait',
      action: '人工确认后建仓',
      displayTone: 'buy',
      commandLabel: '执行预案',
      detailActionLabel: '查看建仓依据',
      shortHorizon: clean(advice.shortHorizon, 30),
      instruction: initialInstruction,
      quantity: pendingEntry.quantity,
      quantityLabel: '',
      levels: proposalLevels,
      trigger: {
        direction: 'inactive',
        price: pendingEntry.buyPrice,
        label: '需要人工确认',
        stateLabel: '确认后可执行',
        detailLabel: '确认后按计划手动建仓',
        metricLabel: '不自动下单',
      },
      actionability: plan?.actionability || 'WATCH',
      manualOnly: true,
      actionable: false,
      deferred: false,
      deferredReason: '',
    }
  }
  const triggerDirection = executionTriggerDirection({
    action: plan?.action || {
      buy: 'BUY',
      add: 'ADD',
      reduce: 'REDUCE',
      sell: 'EXIT',
    }[kind],
    trigger: initialInstruction,
    triggerDirection: plan?.triggerDirection,
  })
  const allLevels = withPriceBasis(
    levelsFor(kind, source, triggerDirection, followUp),
    source,
  )
  const primaryWaitLevel = kind === 'wait'
    ? preferredWaitLevel(allLevels, source, current)
    : null
  const levels = kind === 'wait' && primaryWaitLevel
    ? [primaryWaitLevel]
    : allLevels
  const instruction = (
    kind === 'wait'
    && primaryWaitLevel
    && !policyOpportunity
  )
    ? waitPathInstruction(
        primaryWaitLevel,
        quantityText(advice.planQtyNum ?? advice.planQty),
      )
    : initialInstruction
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
    ? policyOpportunity
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
    const deferredAction = deferredOpportunity?.action
      || (sessionDeferred ? '等待盘中' : '等待突破')
    const deferredInstruction = deferredOpportunity
      ? clean(
          `${deferredOpportunity.instruction}；${reason}`,
          240,
        )
      : `${phasePrefix}：${reason}；满足后重新生成建议`
    return {
      kind: 'wait',
      action: explicitActionLabel(deferredAction, { holdingMode }),
      displayTone: deferredOpportunity?.displayTone,
      commandLabel: deferredOpportunity?.commandLabel,
      detailActionLabel:
        deferredOpportunity?.detailActionLabel,
      shortHorizon: deferredOpportunity?.shortHorizon
        || clean(source.shortHorizon, 30),
      cardInstruction: deferredOpportunity?.cardInstruction,
      instruction: explicitActionInstruction(
        deferredInstruction,
        { holdingMode },
      ),
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
        label: '条件尚未确认',
        stateLabel: sessionDeferred
          ? '下一交易时段再判断'
          : '突破确认后再判断',
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
  const conditionalEntry = (
    !!policyOpportunity
    && mode === 'buy_advice'
    && kind === 'wait'
  )
  const deferredWait = conditionalEntry || (
    !!policyOpportunity
    && (
      executionOpen === false
      || generatedOutsideSession
    )
    && (
      (
        mode === 'buy_advice'
        && kind === 'wait'
      )
      || (
        ['hold_advice', 'review'].includes(mode)
        && ['hold', 'add'].includes(kind)
      )
    )
  )
  const deferredWaitPlan = deferredWait
    ? policyOpportunity
    : null
  const rawDisplayAction = deferredWaitPlan?.action
    || (
      deferredWait
        ? '等待盘中'
        : terminalOutcome
          || (kind === 'wait' && primaryWaitLevel
          ? primaryWaitLevel.key === 'watch_breakout'
            ? '等待突破'
            : '等待回踩'
          : action || ({
              buy: '买入',
              add: '加仓',
              reduce: '减仓',
              sell: '退出',
              hold: '持有',
              wait: '观望',
            }[kind]))
    )
  const displayAction = explicitActionLabel(rawDisplayAction, {
    holdingMode,
    terminal: !!terminalOutcome,
  })
  const displayInstruction = explicitActionInstruction(
    deferredWaitPlan?.instruction || instruction,
    {
      holdingMode,
      terminal: !!terminalOutcome,
    },
  )
  return {
    kind,
    action: displayAction,
    displayTone: deferredWaitPlan?.displayTone,
    commandLabel: deferredWaitPlan?.commandLabel
      || (terminalOutcome ? '复核结论' : null)
      || (kind === 'wait' && primaryWaitLevel ? '唯一条件' : null),
    detailActionLabel: deferredWaitPlan?.detailActionLabel,
    shortHorizon: terminalOutcome
      ? '本次到价已决断'
      : deferredWaitPlan?.shortHorizon
        || clean(source.shortHorizon, 30),
    cardInstruction: deferredWaitPlan?.cardInstruction,
    instruction: displayInstruction,
    quantity,
    quantityLabel: deferredWaitPlan?.quantityLabel,
    levels,
    trigger: terminalOutcome
      ? {
          direction: 'inactive',
          price: null,
          label: '复核完成',
          stateLabel: displayAction,
          detailLabel: '本次价格触发已结束',
          metricLabel: '不再复核原价',
        }
      : deferredWaitPlan?.trigger || (deferredWait
        ? {
          direction: 'inactive',
          price: null,
          label: '条件尚未确认',
          stateLabel: '下一交易时段再判断',
          detailLabel: '盘中满足条件后再提醒',
          metricLabel: '当前不下单',
        }
        : triggerFor(kind, levels, triggerDirection, followUp)),
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

const ENTRY_ROUTE_LABEL = Object.freeze({
  DUAL_CORE: '量化资金双核共振',
  BREAKOUT_MOMENTUM: '放量突破确认',
  QUANT_MOMENTUM: '量化强势',
  FLOW_LEADERSHIP: '资金领涨',
})

// 从决策计划的动作政策中提炼"这次该下多重的手"给卡片做强高亮。
// 只在方向已通过（FULL 正式建仓 / PROBE 小仓试错）时返回，观望一律为空。
export function entryConvictionView(advice = {}) {
  const plan = advice?.decisionPlan?.schemaVersion === 'decision-plan.v2'
    ? advice.decisionPlan
    : null
  const policy = plan?.actionPolicy
  if (!policy) return null
  const actionable = ['READY', 'MANUAL_PROBE'].includes(plan.actionability)
  if (!actionable) return null
  const tier = policy.riskTier
  const route = ENTRY_ROUTE_LABEL[policy.entryRoute] || ''
  const confirmations = (Array.isArray(policy.confirmations)
    ? policy.confirmations
    : []).map((item) => clean(item, 20)).filter(Boolean).slice(0, 3)
  if (tier === 'FULL') {
    const band = policy.positionBandPct
    const sizeValue = band
      && Number.isFinite(Number(band.min))
      && Number.isFinite(Number(band.max))
      ? `${band.min}–${band.max}%`
      : ''
    return {
      tier: 'FULL',
      sizeLabel: '正式建仓',
      sizeValue,
      route,
      confirmations,
      tone: 'buy',
    }
  }
  if (tier === 'PROBE') {
    const max = Number(policy.maxPositionPct)
    return {
      tier: 'PROBE',
      sizeLabel: '小仓试错',
      sizeValue: Number.isFinite(max) && max > 0 ? `≤${max}%` : '',
      route,
      confirmations,
      tone: 'probe',
    }
  }
  return null
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
    const view = buildAdviceActionView({
      ...source,
      shortHorizonTactical: null,
      action: '持有',
      stance: '持有',
      opQty: '今日不可卖',
      actionPlan: instruction,
      reducePrice: source.reducePrice ?? targetPrice,
      stopPrice: source.stopPrice ?? stopPrice,
      targetPrice: source.targetPrice ?? targetPrice,
    }, { mode: 'hold_advice' })
    const nextSession = nextTradeDay || '下一交易日'
    return {
      ...view,
      trigger: view.trigger?.direction === 'range'
        ? {
            ...view.trigger,
            metricLabel: '今日不可卖',
            lowReachedHint:
              `今日可卖0手，${nextSession}盘中优先处理止损`,
            highReachedHint:
              `今日可卖0手，${nextSession}盘中复核减仓`,
          }
        : view.trigger,
    }
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

  if (trigger.direction === 'review_paths') {
    const paths = Array.isArray(trigger.paths) ? trigger.paths : []
    const reached = paths.find((path) =>
      path.direction === 'LTE'
        ? current <= finite(path.price)
        : current >= finite(path.price)
    )
    if (reached) {
      return {
        pct: 100,
        score: 100,
        tone: 'buy',
        label: `现价已满足${reached.label}`,
        metricLabel: trigger.metricLabel,
        stateLabel: `${reached.label}已到`,
        reached: true,
        reachedKey: reached.key,
        reachedHint: '已到价，正在提交复核',
        currentPrice: current,
      }
    }
    const distances = paths.map((path) => ({
      ...path,
      distance: Math.abs(current - path.price) / path.price * 100,
    })).sort((left, right) => left.distance - right.distance)
    const nearest = distances[0]
    if (!nearest) return null
    return {
      pct: rounded(clamp(100 - nearest.distance / 8 * 100)),
      score: rounded(clamp(100 - nearest.distance / 8 * 100)),
      tone: 'buy',
      label: `距${nearest.label} ${nearest.distance.toFixed(1)}%`,
      metricLabel: trigger.metricLabel,
      stateLabel: '加仓条件监控中',
      reached: false,
      reachedKey: '',
      currentPrice: current,
    }
  }

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
        label: `低于${trigger.lowLabel || '回踩位'} ${distance.toFixed(1)}%`,
        metricLabel: trigger.metricLabel,
        stateLabel: `已到${trigger.lowLabel || '回踩位'}`,
        reached: true,
        reachedKey: trigger.lowKey || 'add',
        reachedHint: trigger.lowReachedHint || '需要重新评估',
        currentPrice: current,
      }
    }
    if (current > high) {
      const distance = (current - high) / high * 100
      return {
        pct: 100,
        score: 100,
        tone: 'sell',
        label: `高于${trigger.highLabel || '反弹位'} ${distance.toFixed(1)}%`,
        metricLabel: trigger.metricLabel,
        stateLabel: `已到${trigger.highLabel || '反弹位'}`,
        reached: true,
        reachedKey: trigger.highKey || 'reduce',
        reachedHint: trigger.highReachedHint || '需要重新评估',
        currentPrice: current,
      }
    }
    const position = clamp((current - low) / (high - low) * 100)
    return {
      pct: rounded(position),
      score: rounded(position),
      tone: 'range',
      label: position < 34
        ? `现价靠近${trigger.lowLabel || '回踩位'}`
        : position > 66
          ? `现价靠近${trigger.highLabel || '反弹位'}`
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
          ? '反弹条件监控中'
          : trigger.metricLabel === '减仓条件'
            ? '跌破条件监控中'
            : '回踩条件监控中',
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
    label: `已到${trigger.label} · 正在复核`,
    metricLabel: trigger.metricLabel,
    stateLabel: `已到${trigger.label}`,
    reached: true,
    currentPrice: current,
  }
}
