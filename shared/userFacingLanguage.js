const EXACT_REWRITES = [
  [
    /依赖条件未满足[，,]\s*本轮未执行[（(]TRIGGERED_REVIEW_REUSE_PREVIOUS[）)]/g,
    '原建议没有可复用的量化结果，本轮快速复核不重复计算',
  ],
  [
    /\bTRIGGERED_REVIEW_REUSE_PREVIOUS\b/g,
    '原建议没有可复用的量化结果，本轮快速复核不重复计算',
  ],
  [
    /\bTRIGGERED_REVIEW_FAST_PATH\b/g,
    '到价复核只采集当前决策所需的实时证据',
  ],
  [
    /\bQUICK_ADVICE_FAST_PATH\b/g,
    '快速建议只采集价格决策所需证据',
  ],
  [
    /\bQUICK_ADVICE_SKIP_LIVE_SEARCH\b/g,
    '快速建议不等待联网检索',
  ],
  [
    /策略闸门\s*productionEligible\s*(?:为|=)\s*(?:真|true)[、，,\s]*策略路线进入生产可执行[、，,\s]*(?:且)?\s*marketEnv\.regime\s*不再为\s*RISK_OFF\s*时[，,]?\s*观望失效[。.]?/gi,
    '历史限制已取消；市场结束防守状态且量价、资金与风险条件确认后，重新评估是否买入。',
  ],
  [
    /strategyGate\.productionEligible\s*(?:为|=)\s*(?:真|true)/gi,
    '历史限制已取消',
  ],
  [
    /strategyGate\.productionEligible\s*(?:为|=)\s*(?:假|false)/gi,
    '历史限制已取消，改按当前证据重新评估',
  ],
  [
    /productionEligible\s*(?:为|=)\s*(?:真|true)/gi,
    '历史限制已取消',
  ],
  [
    /productionEligible\s*(?:为|=)\s*(?:假|false)/gi,
    '历史限制已取消，改按当前证据重新评估',
  ],
  [
    /strategyRoute\s*(?:为|=)\s*SHADOW_ONLY/gi,
    '历史限制已取消，改按当前证据重新评估',
  ],
  [
    /marketEnv\.regime\s*不再为\s*RISK_OFF/gi,
    '市场结束防守状态',
  ],
  [
    /marketEnv\.regime\s*(?:为|=)\s*RISK_OFF/gi,
    '市场处于防守状态',
  ],
  [
    /策略尚未通过生产晋级[，,；;]?\s*仅作为研究级条件建议/g,
    '历史限制已取消，改按当前证据重新评估',
  ],
  [/策略路线进入生产可执行/g, '当前证据允许执行'],
  [/研究级条件建议/g, '仅供观察，暂不可直接执行'],
  [/策略晋级前不进入强执行确认/g, '按当前证据重新评估是否执行'],
  [/生产晋级/g, '历史限制'],
  [/确定性闸门/g, '执行条件'],
  [/强执行确认/g, '直接执行'],
  [/硬闸门/g, '强制风险检查'],
  [/观望失效/g, '重新评估是否买入'],
]

const TERM_REWRITES = [
  [/\bstrategyGate\b/g, '历史限制'],
  [/\bstrategyRoute\.production\b/g, '历史执行路径'],
  [/\bstrategyRoute\.research\b/g, '历史观察路径'],
  [/\bstrategyRoute\b/g, '历史决策路径'],
  [/\bmarketEnv\.regime\b/g, '市场状态'],
  [/\bmarketRegime\b/g, '市场状态'],
  [/\bproductionEligible\b/g, '历史启用状态'],
  [/\bactionability\b/g, '执行状态'],
  [/\bspecVersion\b/g, '历史规则版本'],
  [/\bblockerCodes\b/g, '未通过原因'],
  [/\bquant\.highConfSignal\.fired\b/g, '高把握买点信号'],
  [/\bcounterTrend\.isStrong\b/g, '个股逆势强度'],
  [/\baccountCircuitBreaker\.allowRiskIncrease\b/g, '账户是否允许加仓'],
  [/\bmainNetYi\b/g, '主力净流入额'],
  [/\b(?:retailNetYi|smallNetYi)\b/g, '小单净流入额'],
  [/\bmain5dYi\b/g, '近5日主力净额'],
  [/\btrend5\b/g, '近5日主力走势'],
  [/\binflowDays\b/g, '近5日主力流入天数'],
  [/\bmainStreak\b/g, '主力连续流入或流出天数'],
  [/\bposInDay\b/g, '日内价格位置'],
  [/\bupProb\b/g, '上涨概率'],
  [/\bSHADOW_ONLY\b/g, '仅模拟观察'],
  [/\bRESEARCH_ONLY\b/g, '仅供研究'],
  [/\bMANUAL_PROBE\b/g, '人工小仓试错'],
  [/\bTREND_STRONG\b/g, '强趋势'],
  [/\bTRANSITION\b/g, '趋势切换期'],
  [/\bRISK_OFF\b/g, '防守状态'],
  [/\bRANGE\b/g, '震荡区间'],
  [/\bREADY\b/g, '可执行'],
  [/\bBLOCKED\b/g, '暂不可执行'],
  [/\bUNKNOWN\b/g, '当前数据不足，暂未判断'],
  [/\bREJECT(?:ED)?\b/gi, '未通过'],
  [/\bPROMOTE(?:D)?\b/gi, '已通过'],
  [/\bStrategySpec\s*v?2\b/gi, '历史规则'],
  [/\bWalk-forward\b/gi, '滚动历史检验'],
  [/\bProfit Factor\b/gi, '盈亏效率'],
]

const TEXT_FIELDS = new Set([
  'actionPlan',
  'actual',
  'addOn',
  'advice',
  'bearCase',
  'beginnerNote',
  'cashStrategy',
  'changeReason',
  'confirmSignal',
  'confidenceReason',
  'condition',
  'conclusion',
  'counterCase',
  'crowdingRisk',
  'catalystWindow',
  'description',
  'edge',
  'executionPlan',
  'exitConditions',
  'exitTiming',
  'futurePlan',
  'fundNote',
  'headline',
  'histPattern',
  'impact',
  'instruction',
  'invalidation',
  'keyLevel',
  'logic',
  'macroNote',
  'marketNote',
  'marketMood',
  'message',
  'newsNote',
  'nextAction',
  'nextOpenPlan',
  'nextReviewTrigger',
  'noTradeReason',
  'noRecommendationText',
  'note',
  'plain',
  'positionNote',
  'principle',
  'rationale',
  'reason',
  'reasoning',
  'recovery',
  'researchLogic',
  'risk',
  'riskPoints',
  'reviewTrigger',
  'seatNote',
  'serverAdjust',
  'signal',
  'shortHorizon',
  'stockNote',
  'stop',
  'strategy',
  'statusText',
  'styleReason',
  'summary',
  'techNote',
  'text',
  'theory',
  'theoryNote',
  'timing',
  'title',
  'topRisk',
  'todayRecap',
  'todayGoal',
  'tradeReview',
  'trigger',
  'triggerConditions',
  'verdict',
  'view',
  'watch',
  'warning',
  'whyNow',
])

const TEXT_ARRAY_FIELDS = new Set([
  'actions',
  'blockedReasons',
  'dynamicRules',
  'missing',
  'reasons',
  'risks',
  'violations',
])

export function timeBoundReviewText(value, { terminal = false } = {}) {
  if (value == null) return value
  let text = String(value)
  text = text.replace(
    /回踩后(?:不能|不会|未能|无法)(?:重新)?站回\s*(\d+(?:\.\d+)?)\s*元(?:分时)?均价(?:线)?\s*[，,]?\s*则取消本次关注/g,
    (_, price) => terminal
      ? `截至本次复核，尚未确认价格已重新站回${price}元分时均价，因此本次不买入；若之后重新站回且量价、资金转强，作为新事件重新评估`
      : `回踩触价后，若到价复核时尚未确认价格已重新站回${price}元分时均价，则本次不买入；若之后重新站回且量价、资金转强，作为新事件重新评估`,
  )
  return text.replace(
    /(若[^。；]{0,80}?)(?:不能|不会|无法)(?:重新)?站回/g,
    '$1截至复核时仍未站回',
  )
}

export function humanizeUserFacingText(value) {
  if (value == null) return value
  let text = String(value)
  for (const [pattern, replacement] of EXACT_REWRITES) {
    text = text.replace(pattern, replacement)
  }
  for (const [pattern, replacement] of TERM_REWRITES) {
    text = text.replace(pattern, replacement)
  }
  return timeBoundReviewText(text)
}

export function explicitActionLabel(
  value,
  { holdingMode = false, terminal = false } = {},
) {
  const text = humanizeUserFacingText(value ?? '').trim()
  if (!text) return ''
  const reviewTitle = text.match(/^到价复核\s*[：:]\s*(.+)$/)
  if (reviewTitle) {
    return `到价复核：${explicitActionLabel(reviewTitle[1], {
      holdingMode,
      terminal: true,
    })}`
  }
  if (/^(?:维持|保持|继续)?持有$/.test(text)) {
    return terminal ? '本次不加仓、不减仓' : '继续持有'
  }
  if (/^(?:维持|保持|继续)?观望$/.test(text)) {
    return terminal ? '本次不买入' : '暂不买入'
  }
  if (/^(?:暂不|无需|不)操作$/.test(text)) {
    return holdingMode ? '本次不加仓、不减仓' : '本次不买入'
  }
  return {
    等待确认: '条件尚未确认',
    等待量化信号: '量化结果尚未返回',
    等待盘中: '下一交易时段再判断',
    等待突破: '突破后再判断',
    等待回踩: '回踩后再判断',
    待确认建仓: '人工确认后建仓',
    等待人工确认: '人工确认后执行',
  }[text] || text
}

export function explicitActionInstruction(
  value,
  { holdingMode = false, terminal = false } = {},
) {
  let text = humanizeUserFacingText(value ?? '').trim()
  if (!text) return ''
  const prefixMatch = text.match(
    /^((?:结论|到价复核)\s*[：:]\s*)/,
  )
  const prefix = prefixMatch?.[1] || ''
  const actionText = prefix ? text.slice(prefix.length) : text
  if (
    terminal
    && /^(?:维持|保持|继续)?持有(?:现有仓位)?(?=[：:；;，,。\s]|$)/.test(
      actionText,
    )
  ) {
    text = text.replace(
      /^((?:结论|到价复核)\s*[：:]\s*)?(?:维持|保持|继续)?持有(?:现有仓位)?(?=[：:；;，,。\s]|$)/,
      `${prefix}本次不加仓、不减仓，继续持有现有仓位`,
    )
  } else if (
    terminal
    && /^(?:维持|保持|继续)?观望(?=[：:；;，,。\s]|$)/.test(
      actionText,
    )
  ) {
    text = text.replace(
      /^((?:结论|到价复核)\s*[：:]\s*)?(?:维持|保持|继续)?观望(?=[：:；;，,。\s]|$)/,
      `${prefix}本次不买入`,
    )
  } else if (/^维持原计划/.test(text)) {
    text = text.replace(
      /^维持原计划/,
      holdingMode
        ? '本次不加仓、不减仓，继续持有现有仓位'
        : '本次不买入',
    )
  } else if (/^等待确认/.test(text)) {
    text = text.replace(
      /^等待确认/,
      '当前不执行；待价格、量能和资金条件确认后再判断',
    )
  } else if (/^等待量化信号/.test(text)) {
    text = text.replace(/^等待量化信号/, '量化结果尚未返回')
  } else if (/^(?:暂不执行|(?:暂不|无需|不)操作)/.test(text)) {
    text = text.replace(
      /^(?:暂不执行|(?:暂不|无需|不)操作)/,
      holdingMode ? '本次不加仓、不减仓' : '本次不买入',
    )
  } else if (/^等待回踩/.test(text)) {
    text = text.replace(
      /^等待回踩/,
      holdingMode
        ? '本次不加仓、不减仓；回踩'
        : '本次不买入；回踩',
    )
  } else if (/^等待突破/.test(text)) {
    text = text.replace(
      /^等待突破/,
      holdingMode
        ? '本次不加仓、不减仓；突破'
        : '本次不买入；突破',
    )
  } else if (/^等待盘中/.test(text)) {
    text = text.replace(
      /^等待盘中/,
      '当前不执行；下一交易时段',
    )
  } else if (/^等待触发/.test(text)) {
    text = text.replace(
      /^等待触发/,
      holdingMode
        ? '本次不加仓、不减仓；触发'
        : '本次不买入；触发',
    )
  }
  return text
}

export function humanizeAdviceTextFields(value, field = '') {
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'string' && TEXT_ARRAY_FIELDS.has(field)
        ? humanizeUserFacingText(item)
        : humanizeAdviceTextFields(item, field)
    )
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && TEXT_FIELDS.has(field)
      ? humanizeUserFacingText(value)
      : value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      humanizeAdviceTextFields(item, key),
    ]),
  )
}

export function marketRegimeLabel(value) {
  return {
    TREND_STRONG: '强趋势',
    RANGE: '震荡',
    TRANSITION: '趋势切换期',
    RISK_OFF: '防守',
    UNKNOWN: '暂未判断',
  }[String(value || '')] || humanizeUserFacingText(value || '暂未判断')
}

export function actionabilityLabel(value) {
  return {
    READY: '条件已满足，可执行',
    MANUAL_PROBE: '短线条件已满足，需人工确认',
    RESEARCH_ONLY: '历史建议，需按当前证据重新评估',
    BLOCKED: '执行条件未满足，当前不下单',
    WATCH: '当前不执行，达到触发条件后再判断',
  }[String(value || '')] || '执行条件尚未确认'
}
