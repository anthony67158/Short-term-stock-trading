const EXACT_REWRITES = [
  [
    /策略闸门\s*productionEligible\s*(?:为|=)\s*(?:真|true)[、，,\s]*策略路线进入生产可执行[、，,\s]*(?:且)?\s*marketEnv\.regime\s*不再为\s*RISK_OFF\s*时[，,]?\s*观望失效[。.]?/gi,
    '当策略通过实盘启用审核、当前行情匹配可执行策略，且市场结束防守状态时，重新评估是否买入。',
  ],
  [
    /strategyGate\.productionEligible\s*(?:为|=)\s*(?:真|true)/gi,
    '策略已通过实盘启用审核',
  ],
  [
    /strategyGate\.productionEligible\s*(?:为|=)\s*(?:假|false)/gi,
    '策略尚未通过实盘启用审核',
  ],
  [
    /productionEligible\s*(?:为|=)\s*(?:真|true)/gi,
    '策略已通过实盘启用审核',
  ],
  [
    /productionEligible\s*(?:为|=)\s*(?:假|false)/gi,
    '策略尚未通过实盘启用审核',
  ],
  [
    /strategyRoute\s*(?:为|=)\s*SHADOW_ONLY/gi,
    '当前适用策略仅模拟观察',
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
    '策略尚未通过实盘启用审核，本轮只用于观察',
  ],
  [/策略路线进入生产可执行/g, '当前行情匹配可执行策略'],
  [/研究级条件建议/g, '仅供观察，暂不可直接执行'],
  [/策略晋级前不进入强执行确认/g, '策略通过实盘启用审核前，不能直接执行'],
  [/生产晋级/g, '实盘启用审核'],
  [/确定性闸门/g, '执行条件'],
  [/强执行确认/g, '直接执行'],
  [/硬闸门/g, '强制风险检查'],
  [/观望失效/g, '重新评估是否买入'],
]

const TERM_REWRITES = [
  [/\bstrategyGate\b/g, '策略审核'],
  [/\bstrategyRoute\.production\b/g, '当前可执行策略'],
  [/\bstrategyRoute\.research\b/g, '当前研究策略'],
  [/\bstrategyRoute\b/g, '当前适用策略'],
  [/\bmarketEnv\.regime\b/g, '市场状态'],
  [/\bmarketRegime\b/g, '市场状态'],
  [/\bproductionEligible\b/g, '实盘启用资格'],
  [/\bactionability\b/g, '执行状态'],
  [/\bspecVersion\b/g, '策略版本'],
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
  [/\bUNKNOWN\b/g, '状态待确认'],
  [/\bREJECT(?:ED)?\b/gi, '未通过'],
  [/\bPROMOTE(?:D)?\b/gi, '已通过'],
  [/\bStrategySpec\s*v?2\b/gi, '当前策略规则'],
  [/\bWalk-forward\b/gi, '滚动历史检验'],
  [/\bProfit Factor\b/gi, '盈亏效率'],
]

const TEXT_FIELDS = new Set([
  'actionPlan',
  'actual',
  'addOn',
  'advice',
  'bearCase',
  'cashStrategy',
  'changeReason',
  'confirmSignal',
  'confidenceReason',
  'condition',
  'conclusion',
  'counterCase',
  'description',
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
  'seatNote',
  'serverAdjust',
  'signal',
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

export function humanizeUserFacingText(value) {
  if (value == null) return value
  let text = String(value)
  for (const [pattern, replacement] of EXACT_REWRITES) {
    text = text.replace(pattern, replacement)
  }
  for (const [pattern, replacement] of TERM_REWRITES) {
    text = text.replace(pattern, replacement)
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

export function strategyStateLabel(value) {
  return {
    draft: '待验证',
    backtested: '已完成回测',
    rejected: '未通过',
    shadow: '模拟观察',
    'paper-qualified': '模拟结果达标',
    approved: '已审核',
    active: '已启用',
    suspended: '已暂停',
    retired: '已停用',
  }[String(value || '')] || humanizeUserFacingText(value || '待确认')
}

export function actionabilityLabel(value) {
  return {
    READY: '条件已满足，可执行',
    MANUAL_PROBE: '短线条件已满足，需人工确认',
    RESEARCH_ONLY: '仅供观察，暂不可执行',
    BLOCKED: '条件未满足，暂不执行',
    WATCH: '等待条件满足',
  }[String(value || '')] || '等待确认'
}
