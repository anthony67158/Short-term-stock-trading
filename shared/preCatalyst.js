import {
  beijingDayKey,
  nextTradingDate,
} from './tradingCalendar.js'

export const PRE_CATALYST_SCHEMA_VERSION = 'pre-catalyst.v1'

const OFFICIAL_HOST = 'static.cninfo.com.cn'
const EVENT_RULES = Object.freeze([
  {
    eventType: 'ORDER',
    eventLabel: '重大订单',
    score: 86,
    pattern: /中标|预中标|签订.{0,12}(合同|协议)|重大合同|重大订单|订单增长/,
  },
  {
    eventType: 'CAPACITY',
    eventLabel: '产能进展',
    score: 78,
    pattern: /投产|量产|试生产|产能释放|扩建项目|项目验收|竣工验收/,
  },
  {
    eventType: 'PRODUCT',
    eventLabel: '产品进展',
    score: 76,
    pattern: /获得.{0,10}(批准|批复|注册证|认证)|新产品|技术突破|临床试验|产品验证/,
  },
  {
    eventType: 'EARNINGS',
    eventLabel: '经营改善',
    score: 74,
    pattern: /业绩预增|业绩快报|扭亏为盈|订单饱满|产销快报/,
  },
  {
    eventType: 'BUYBACK',
    eventLabel: '增持回购',
    score: 68,
    pattern: /增持.{0,12}(计划|股份)|回购.{0,12}(计划|报告书)|首次回购/,
  },
  {
    eventType: 'RESTRUCTURING',
    eventLabel: '重组进展',
    score: 64,
    pattern: /并购|重组|收购|控制权.{0,8}(变更|转让)/,
  },
  {
    eventType: 'INSTITUTION_VISIT',
    eventLabel: '机构调研',
    score: 58,
    pattern: /投资者关系活动记录|机构调研|现场调研|分析师会议/,
  },
])

const NEGATIVE_PATTERN =
  /减持|行政处罚|立案|退市风险|终止上市|重大诉讼|重大亏损|业绩预减|业绩首亏|债务逾期|资金占用|违规担保|风险提示/
const NOISE_PATTERN =
  /董事会第.{0,12}次会议决议|监事会第.{0,12}次会议决议|召开.{0,12}股东会|权益分派实施|独立董事任期|工商变更登记|章程|管理制度/

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function round(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function text(value, limit = 180) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function officialAnnouncementUrl(value) {
  const path = String(value || '').trim().replace(/^\/+/, '')
  if (!/^finalpage\/[\w./-]+\.(pdf|PDF)$/.test(path)) return ''
  try {
    const url = new URL(`https://${OFFICIAL_HOST}/${path}`)
    return url.protocol === 'https:' && url.hostname === OFFICIAL_HOST
      ? url.href
      : ''
  } catch {
    return ''
  }
}

function nextTradingDayLabel(timestamp) {
  const next = nextTradingDate(Number(timestamp) || Date.now())
  return next ? beijingDayKey(next.getTime()) : ''
}

function normalizeCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((item) => ({
      date: text(item?.date, 16),
      open: finite(item?.open),
      high: finite(item?.high),
      low: finite(item?.low),
      close: finite(item?.close),
      amount: finite(item?.amount),
    }))
    .filter((item) =>
      item.date
      && item.open > 0
      && item.high > 0
      && item.low > 0
      && item.close > 0,
    )
    .sort((left, right) => left.date.localeCompare(right.date))
}

function average(values = []) {
  const valid = values.filter((value) => finite(value) != null)
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + Number(value), 0) / valid.length
}

function atr14(rows = []) {
  if (rows.length < 15) return null
  const values = []
  for (let index = rows.length - 14; index < rows.length; index += 1) {
    const current = rows[index]
    const previous = rows[index - 1]
    values.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ))
  }
  return average(values)
}

function priceContract(quote = {}, candles = [], now = Date.now()) {
  const current = finite(quote.price)
  const rows = normalizeCandles(candles)
  const atr = atr14(rows)
  if (!(current > 0) || !(atr > 0)) return null
  const ma5 = average(rows.slice(-5).map((item) => item.close))
  const recentHigh = Math.max(...rows.slice(-5).map((item) => item.high))
  const pullback = Math.min(
    current * 0.995,
    ma5 > 0 ? ma5 : current * 0.995,
  )
  const breakout = Math.max(current * 1.006, recentHigh * 1.002)
  const breakoutReachable = breakout - current <= atr * 1.5
  const entry = breakoutReachable ? breakout : pullback
  if (!(entry > 0) || Math.abs(entry - current) > atr * 1.5) return null
  const risk = Math.max(atr * 1.1, entry * 0.025)
  const stop = entry - risk
  const target = entry + risk * 1.8
  if (!(stop > 0) || !(target > entry)) return null
  return {
    riskReward: 1.8,
    entryPlan: {
      type: breakoutReachable ? 'BREAKOUT' : 'PULLBACK',
      price: round(entry),
      window: '未来1-3个交易日，确认后执行',
      trigger: breakoutReachable
        ? '放量突破近期压力且资金结构继续改善'
        : '回踩参考价后重新站稳且资金结构未转弱',
      maxPositionPct: 3,
      validUntil: Number(now) + 5 * 86400000,
    },
    exitPlan: {
      hardStopPrice: round(stop),
      takeProfitPrice: round(target),
      timeStopDate: nextTradingDayLabel(
        Number(now) + 4 * 86400000,
      ),
      rule:
        '目标或止损先到先执行；第3个交易日仍未启动则取消计划',
      t1Constraint:
        '当日买入不可卖出，下一可卖时段优先处理风险',
    },
  }
}

export function classifyPreCatalystEvent(titleValue) {
  const title = text(titleValue)
  if (!title) {
    return {
      eligible: false,
      eventType: 'UNKNOWN',
      eventLabel: '未知事件',
      direction: 'UNCERTAIN',
      materialityScore: 0,
    }
  }
  if (NEGATIVE_PATTERN.test(title)) {
    return {
      eligible: false,
      eventType: 'RISK',
      eventLabel: '风险事件',
      direction: 'NEGATIVE',
      materialityScore: 90,
    }
  }
  if (NOISE_PATTERN.test(title)) {
    return {
      eligible: false,
      eventType: 'ROUTINE',
      eventLabel: '日常公告',
      direction: 'UNCERTAIN',
      materialityScore: 10,
    }
  }
  const matched = EVENT_RULES.find((rule) => rule.pattern.test(title))
  if (!matched) {
    return {
      eligible: false,
      eventType: 'OTHER',
      eventLabel: '其它公告',
      direction: 'UNCERTAIN',
      materialityScore: 25,
    }
  }
  return {
    eligible: true,
    eventType: matched.eventType,
    eventLabel: matched.eventLabel,
    direction: matched.eventType === 'RESTRUCTURING'
      || matched.eventType === 'INSTITUTION_VISIT'
      ? 'UNCERTAIN'
      : 'POSITIVE',
    materialityScore: matched.score,
  }
}

export function normalizePreCatalystAnnouncement(
  value = {},
  { now = Date.now() } = {},
) {
  const code = String(value.secCode || value.code || '').trim()
  const announcementId = text(
    value.announcementId || value.id,
    40,
  )
  const title = text(
    value.announcementTitle || value.title,
  )
  const publishedAt = finite(
    value.announcementTime || value.publishedAt,
  )
  const sourceUrl = officialAnnouncementUrl(
    value.adjunctUrl || value.sourceUrl,
  )
  if (
    !/^\d{6}$/.test(code)
    || !/^[A-Za-z0-9_-]{6,40}$/.test(announcementId)
    || !title
    || !(publishedAt > 0)
    || publishedAt > Number(now) + 5 * 60 * 1000
    || !sourceUrl
  ) return null
  return {
    schemaVersion: PRE_CATALYST_SCHEMA_VERSION,
    eventId: `CNINFO:${announcementId}`,
    code,
    name: text(value.secName || value.name, 60),
    title,
    publishedAt,
    firstSeenAt: finite(value.firstSeenAt) || Number(now),
    source: '巨潮资讯',
    sourceAuthority: 'OFFICIAL',
    sourceUrl,
    ...classifyPreCatalystEvent(title),
  }
}

export function buildPreCatalystCandidate({
  event = {},
  relation = {},
  quote = {},
  candles = [],
  tags = {},
  now = Date.now(),
} = {}) {
  const code = String(quote.code || event.code || '').trim()
  const price = finite(quote.price)
  const pct = finite(quote.pct)
  const amount = finite(quote.amount)
  const turnover = finite(quote.turnover)
  if (
    !/^\d{6}$/.test(code)
    || event.direction === 'NEGATIVE'
    || event.eligible === false
    || !(price > 0)
    || pct == null
    || !(amount >= 30_000_000)
    || turnover == null
    || Math.abs(pct) >= 7
  ) return null

  const eventScore = clamp(event.materialityScore)
  const relationScore = clamp(
    finite(relation.score)
    ?? (relation.type === 'DIRECT' ? 100 : 55),
  )
  const amountPercentile = clamp(
    (finite(quote.amountPercentile) ?? 0.5) * 100,
  )
  const turnoverPercentile = clamp(
    (finite(quote.turnoverPercentile) ?? 0.5) * 100,
  )
  const priceUnderReaction = clamp(100 - Math.abs(pct) * 18)
  const attentionGap = clamp(
    100 - Math.max(amountPercentile, turnoverPercentile),
  )
  const underReactionScore = clamp(
    priceUnderReaction * 0.7 + attentionGap * 0.3,
  )
  const mainInflow = finite(quote.mainInflow) ?? 0
  const mainRatio = finite(quote.mainRatio) ?? 0
  const volumeRatio = finite(quote.volumeRatio) ?? 0
  const flowProbeScore = clamp(
    38
    + mainRatio * 3
    + (mainInflow > 0 ? 10 : mainInflow < 0 ? -10 : 0)
    + (volumeRatio >= 0.8 && volumeRatio <= 1.8 ? 14 : 0),
  )
  const crowdingRisk = clamp(
    Math.max(0, pct - 2) * 14
    + Math.max(0, turnover - 8) * 4
    + Math.max(0, volumeRatio - 2.5) * 10
    + (quote.isLimitUp === true ? 60 : 0),
  )
  if (crowdingRisk >= 70) return null
  const activationScore = round(clamp(
    eventScore * 0.4
    + relationScore * 0.15
    + underReactionScore * 0.25
    + flowProbeScore * 0.2
    - crowdingRisk * 0.35,
  ), 1)
  if (!(activationScore >= 52)) return null

  const contract = priceContract(quote, candles, now)
  if (!contract) return null
  const dailyRows = normalizeCandles(candles)
  const signalTradeDate = text(quote.tradeDate, 16)
  const baselineDailyAmount = average(
    dailyRows
      .filter((item) =>
        !signalTradeDate || item.date < signalTradeDate
      )
      .slice(-5)
      .map((item) => item.amount),
  )
  const relationLabel = relation.type === 'DIRECT'
    ? '公告主体'
    : relation.type === 'MENTIONED_COMPANY'
      ? '公告关联公司'
      : relation.type === 'SUPPLY_CHAIN'
        ? '产业链关联'
        : '同题材扩散'
  const concepts = Array.isArray(tags.concepts)
    ? tags.concepts.map((item) => text(item, 40)).filter(Boolean)
    : []
  return {
    schemaVersion: PRE_CATALYST_SCHEMA_VERSION,
    code,
    name: text(quote.name || event.name, 60),
    state: 'WAIT_TRIGGER',
    stateLabel: '潜伏预判',
    origin: 'PRE_CATALYST',
    eventIds: [text(event.eventId, 80)].filter(Boolean),
    event: {
      eventId: text(event.eventId, 80),
      eventType: text(event.eventType, 40),
      eventLabel: text(event.eventLabel, 40),
      title: text(event.title),
      publishedAt: finite(event.publishedAt),
      source: text(event.source || '巨潮资讯', 40),
      sourceUrl: officialAnnouncementUrl(event.sourceUrl),
      sourceAuthority: event.sourceAuthority === 'OFFICIAL'
        ? 'OFFICIAL'
        : 'UNVERIFIED',
    },
    relation: {
      type: text(relation.type || 'DIRECT', 40),
      label: relationLabel,
      score: round(relationScore, 1),
      evidence: text(relation.evidence, 120),
      originCode: text(relation.originCode || event.code, 12),
    },
    tags: {
      industry: text(tags.industry, 60),
      concepts,
    },
    quote: {
      code,
      name: text(quote.name || event.name, 60),
      price: round(price),
      pct: round(pct),
      amount: round(amount, 0),
      turnover: round(turnover),
      volumeRatio: round(volumeRatio),
      mainInflow: round(mainInflow, 0),
      mainRatio: round(mainRatio),
      tradeDate: text(quote.tradeDate, 16),
    },
    activationScore,
    eventScore: round(eventScore, 1),
    underReactionScore: round(underReactionScore, 1),
    flowProbeScore: round(flowProbeScore, 1),
    crowdingRisk: round(crowdingRisk, 1),
    forecast: {
      state: 'CALIBRATING',
      pActivation1d: null,
      pActivation3d: null,
      pOutperform5d: null,
      sampleCount: 0,
    },
    evaluationContext: {
      signalTradeDate,
      decisionPrice: round(price),
      baselineDailyAmount: round(baselineDailyAmount, 0),
    },
    score: activationScore,
    opportunityScore: null,
    riskReward: contract.riskReward,
    entryPlan: contract.entryPlan,
    exitPlan: contract.exitPlan,
    sector: {
      code: text(relation.sectorCode, 20),
      name: text(
        relation.sectorName || tags.industry || concepts[0],
        60,
      ),
      phase: 'ACCUMULATION',
      actionability: 'WAIT_PULLBACK',
    },
    sourceSignals: [
      '预催化扫描',
      text(event.eventLabel, 40),
      relationLabel,
    ].filter(Boolean),
    evidence: [
      `官方公告：${text(event.title, 120)}`,
      `${relationLabel}，事件尚未充分扩散到价格`,
      `当日涨跌${round(pct)}%，资金试探分${round(flowProbeScore, 1)}`,
    ],
    blockers: [
      '预催化模型仍在积累样本，仅可等待量价确认',
    ],
    discoveredAt: Number(now) || Date.now(),
  }
}

function conceptKey(candidate = {}) {
  return text(
    candidate.tags?.concepts?.[0]
    || candidate.sector?.name
    || candidate.relation?.originCode
    || candidate.code,
    60,
  )
}

export function rankPreCatalystCandidates(
  candidates = [],
  {
    limit = 20,
    maxPerConcept = 2,
  } = {},
) {
  const byCode = new Map()
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.code) continue
    const current = byCode.get(String(candidate.code))
    if (
      !current
      || Number(candidate.activationScore) > Number(current.activationScore)
    ) byCode.set(String(candidate.code), candidate)
  }
  const conceptCounts = new Map()
  const selected = []
  for (const candidate of [...byCode.values()].sort((left, right) =>
    Number(right.activationScore || 0)
      - Number(left.activationScore || 0)
    || Number(right.eventScore || 0) - Number(left.eventScore || 0)
    || String(left.code).localeCompare(String(right.code))
  )) {
    const key = conceptKey(candidate)
    const count = conceptCounts.get(key) || 0
    if (count >= Math.max(1, Number(maxPerConcept) || 1)) continue
    conceptCounts.set(key, count + 1)
    selected.push(candidate)
    if (selected.length >= Math.max(1, Number(limit) || 1)) break
  }
  return selected
}
