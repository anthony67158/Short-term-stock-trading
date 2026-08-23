export const DAILY_REPORT_SCHEMA_VERSION = 'daily-report.v3'

const SESSION_META = Object.freeze({
  morning: {
    template: 'morning-plan',
    objective: '预判与预案',
  },
  noon: {
    template: 'noon-correction',
    objective: '确认与纠偏',
  },
  evening: {
    template: 'evening-review',
    objective: '复盘与次日预判',
  },
})

const DISCLAIMER =
  '本报告不构成投资建议；行情、资金与披露数据以交易所及官方最终披露为准。'

function text(value, limit = 320) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function numberOrNull(value) {
  if (value == null || value === '' || value === '-') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function boundedRows(rows, limit) {
  return (Array.isArray(rows) ? rows : [])
    .filter((item) => item && typeof item === 'object')
    .slice(0, limit)
}

function validEvidenceIds(values, evidence) {
  const available = new Set(
    (evidence?.items || []).map((item) => String(item?.id || '')),
  )
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => text(value, 8))
      .filter((value) => available.has(value)),
  )].slice(0, 6)
}

function percentProbability(value) {
  const parsed = numberOrNull(value)
  if (parsed == null) return null
  return parsed <= 1 ? +(parsed * 100).toFixed(1) : +parsed.toFixed(1)
}

function actionForSector(actionability) {
  if (actionability === 'LAYOUT') return '回踩承接确认后分批关注，竞价高开不追。'
  if (actionability === 'WAIT_PULLBACK') return '等待回踩关键支撑且资金未转弱后再关注。'
  if (actionability === 'AVOID') return '不新增风险，已有仓位仅在反抽时评估减仓。'
  return '仅观察资金与龙头扩散，条件未满足不执行。'
}

function normalizedPricePlan(tech = {}) {
  const hints = tech?.priceHints || {}
  const zone = (value) => {
    const low = numberOrNull(value?.low)
    const high = numberOrNull(value?.high)
    return low == null && high == null ? null : { low, high }
  }
  return {
    buyZone: zone(hints.buyZone),
    sellZone: zone(hints.sellZone),
    stopLoss: numberOrNull(hints.stopLoss),
    takeProfit: numberOrNull(hints.takeProfit),
  }
}

export function buildMorningCandidatePools({
  sectorForecast = null,
  sectorFlow = {},
  technicalsByCode = {},
  maxSectors = 4,
  maxStocks = 6,
} = {}) {
  const forecastSectors = boundedRows(
    sectorForecast?.sectors,
    maxSectors,
  )
  const sourceSectors = forecastSectors.length
    ? forecastSectors
    : boundedRows(sectorFlow?.top, maxSectors).map((sector, index) => ({
        ...sector,
        rank: index + 1,
        actionability: 'WATCH_ONLY',
        explanation: {
          whyNow: `${text(sector.name, 40)}当前主力净流入${numberOrNull(sector.inflowYi) ?? '数据缺失'}亿元，等待竞价确认延续性。`,
          risks: ['资金数据来自最近交易阶段，开盘后可能快速变化。'],
        },
        stocks: sector.leadCode
          ? [{
              code: sector.leadCode,
              name: sector.lead,
              role: 'leader',
              pct: sector.pct,
            }]
          : [],
      }))
  const sectors = sourceSectors
    .filter((sector) => text(sector?.name, 40))
    .map((sector) => ({
      code: text(sector.code, 16),
      name: text(sector.name, 40),
      rank: numberOrNull(sector.rank),
      actionability: text(sector.actionability || 'WATCH_ONLY', 24),
      nextProbability: percentProbability(
        sector.forecast?.next?.probability,
      ),
      weekProbability: percentProbability(
        sector.forecast?.week?.probability,
      ),
      logic: text(
        sector.explanation?.whyNow
          || (sector.reasons || []).join('；')
          || '板块前瞻排名靠前，等待实时资金确认。',
        240,
      ),
      action: actionForSector(sector.actionability),
      risks: boundedRows(
        (sector.explanation?.risks || sector.risks || [])
          .map((risk) => ({ value: text(risk, 120) })),
        3,
      ).map((item) => item.value),
      dataRefs: ['sector-forecast'],
      evidenceIds: [],
    }))

  const stocks = []
  const seen = new Set()
  for (const sector of sourceSectors) {
    for (const stock of boundedRows(sector?.stocks, 3)) {
      const code = text(stock?.code, 12)
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue
      seen.add(code)
      const tech = technicalsByCode?.[code] || {}
      const pricePlan = normalizedPricePlan(tech)
      stocks.push({
        code,
        name: text(stock.name || code, 40),
        sector: text(sector.name, 40),
        role: text(stock.roleLabel || stock.role || '候选', 32),
        price: numberOrNull(stock.price) ?? numberOrNull(tech.price),
        pct: numberOrNull(stock.pct),
        mainInflow: numberOrNull(stock.mainInflow),
        mainRatio: numberOrNull(stock.mainRatio),
        technical: {
          maTrend: text(tech.maTrend, 16),
          rsi: numberOrNull(tech.rsi),
          support: numberOrNull(tech.sr?.support),
          resistance: numberOrNull(tech.sr?.resistance),
        },
        pricePlan,
        priceBasis: 'QFQ日线参考',
        logic: `${text(sector.name, 40)}候选${stock.roleLabel || stock.role ? `，定位为${text(stock.roleLabel || stock.role, 24)}` : ''}；以板块强度和关键价位共同确认。`,
        action: pricePlan.buyZone
          ? '只在买入区出现承接时关注，跌破止损位取消计划。'
          : '关键价位数据不足，仅观察，不执行买入。',
        dataRefs: ['sector-forecast', 'technical-indicators'],
        evidenceIds: [],
      })
      if (stocks.length >= maxStocks) break
    }
    if (stocks.length >= maxStocks) break
  }

  return {
    source: forecastSectors.length
      ? '板块前瞻 + 日线技术指标'
      : '板块资金排名 + 日线技术指标',
    signalDate: text(sectorForecast?.signalDate, 16),
    generatedAt: numberOrNull(sectorForecast?.generatedAt),
    dataAsOf: text(sectorForecast?.dataAsOf, 32),
    sectors,
    stocks,
  }
}

function sectorFlowMap(sectorFlow = {}) {
  return new Map(
    [
      ...(sectorFlow.top || []),
      ...(sectorFlow.bottom || []),
    ]
      .filter((item) => text(item?.name, 40))
      .map((item) => [text(item.name, 40), item]),
  )
}

export function evaluateMorningPredictions(
  morningReport,
  { sectorFlow = {}, sectorSnapshot = [] } = {},
) {
  const planned = morningReport?.report?.analysis?.sectorPool || []
  if (!planned.length) {
    return [{
      key: 'morning-baseline',
      subject: '盘前早报',
      expected: '',
      status: 'pending',
      actual: '同账号同日盘前早报缺失，无法逐项验证原预判。',
      reasoning: '本场仅呈现当前盘面，不补写或倒推盘前观点。',
      dataRefs: ['daily-report-history'],
      evidenceIds: [],
    }]
  }
  const flows = sectorFlowMap(sectorFlow)
  for (const item of sectorSnapshot || []) {
    const raw = item?.raw || {}
    const row = {
      name: item?.name,
      pct: numberOrNull(raw.currentPct ?? item?.factors?.currentPct),
      inflowYi: numberOrNull(raw.mainInflow) == null
        ? null
        : +(Number(raw.mainInflow) / 1e8).toFixed(2),
    }
    if (item?.code) flows.set(String(item.code), row)
    if (item?.name) flows.set(String(item.name), row)
  }
  return boundedRows(planned, 6).map((item) => {
    const current = flows.get(text(item.code, 48))
      || flows.get(text(item.name, 40))
    const pct = numberOrNull(current?.pct)
    const inflowYi = numberOrNull(current?.inflowYi)
    let status = 'pending'
    if (pct != null && inflowYi != null) {
      if (pct > 0 && inflowYi > 0) status = 'confirmed'
      else if (pct < 0 && inflowYi < 0) status = 'invalidated'
    }
    const actual = current
      ? `${pct == null ? '涨跌缺失' : `涨跌${pct >= 0 ? '+' : ''}${pct}%`}，${inflowYi == null ? '资金缺失' : `主力净${inflowYi >= 0 ? '流入' : '流出'}${Math.abs(inflowYi)}亿元`}`
      : '当前板块资金数据未覆盖，暂不能验证。'
    return {
      key: text(item.code || item.name, 48),
      subject: text(item.name, 40),
      expected: text(item.action || item.logic, 180),
      status,
      actual,
      reasoning: status === 'confirmed'
        ? '价格与主力资金同向，早报逻辑得到上午盘面确认。'
        : status === 'invalidated'
          ? '价格与主力资金同步走弱，早报关注条件已被证伪。'
          : '价格和资金尚未形成同向信号，保留观察但不执行。',
      dataRefs: ['sector-flow'],
      evidenceIds: [],
    }
  })
}

function normalizedMover(item) {
  return {
    code: text(item?.code, 12),
    name: text(item?.name || item?.code, 40),
    price: numberOrNull(item?.price),
    pct: numberOrNull(item?.pct),
    speed: numberOrNull(item?.speed),
    mainInflow: numberOrNull(item?.mainInflow),
    mainRatio: numberOrNull(item?.mainRatio),
    turnover: numberOrNull(item?.turnover),
    dataRefs: ['eastmoney-movers'],
  }
}

function normalizedLhb(raw = {}) {
  return {
    source: '东方财富龙虎榜',
    date: text(raw?.date, 16),
    updatedAt: numberOrNull(raw?.updatedAt),
    stocks: boundedRows(raw?.stocks, 8).map((item) => ({
      code: text(item.code, 12),
      name: text(item.name || item.code, 40),
      price: numberOrNull(item.price),
      pct: numberOrNull(item.pct),
      turnover: numberOrNull(item.turnover),
      net: numberOrNull(item.net),
      buy: numberOrNull(item.buy),
      sell: numberOrNull(item.sell),
      amount: numberOrNull(item.amount),
      reason: text(item.reason, 120),
    })),
    seats: boundedRows(raw?.seats, 8).map((item) => ({
      name: text(item.name, 80),
      alias: text(item.alias, 40),
      buy: numberOrNull(item.buy),
      net: numberOrNull(item.net),
      picks: boundedRows(item.picks, 3).map((pick) => ({
        code: text(pick.code, 12),
        name: text(pick.name || pick.code, 40),
        net: numberOrNull(pick.net),
      })),
    })),
  }
}

export function normalizeNorthboundDisclosure(raw = {}) {
  const totalTurnoverYi = numberOrNull(raw?.totalTurnoverYi)
  const shTurnoverYi = numberOrNull(raw?.shTurnoverYi)
  const szTurnoverYi = numberOrNull(raw?.szTurnoverYi)
  return {
    source: text(raw?.source || '交易所/东方财富互联互通数据', 60),
    date: text(raw?.date, 16),
    updatedAt: numberOrNull(raw?.updatedAt),
    disclosureStatus: totalTurnoverYi == null ? 'unavailable' : 'published',
    totalTurnoverYi,
    shTurnoverYi,
    szTurnoverYi,
    dealCount: numberOrNull(raw?.dealCount),
    netBuyYi: null,
    netBuyDisclosure: '未披露',
    note: '现行披露规则不提供北向实时净买额，不以0代替缺失值。',
    topStocks: boundedRows(raw?.topStocks, 10).map((item) => ({
      code: text(item.code, 12),
      name: text(item.name || item.code, 40),
      market: text(item.market, 20),
      turnoverYi: numberOrNull(item.turnoverYi),
      rank: numberOrNull(item.rank),
    })),
  }
}

function evidenceEvents(evidence, categories, limit) {
  return (evidence?.items || [])
    .filter((item) => categories.includes(item.category))
    .slice(0, limit)
    .map((item) => ({
      title: text(item.title, 160),
      summary: text(item.summary, 260),
      source: text(item.src || item.source, 60),
      publishedAt: text(item.publishedAt || item.date, 32),
      url: text(item.url, 500),
      evidenceLevel: text(item.evidenceLevel, 24),
      evidenceIds: [item.id].filter(Boolean),
    }))
}

function mergePoolViews(base, views, key, evidence) {
  const generated = new Map(
    boundedRows(views, 12).map((item) => [text(item?.[key], 48), item]),
  )
  return base.map((item) => {
    const view = generated.get(text(item[key], 48))
    if (!view) return item
    return {
      ...item,
      logic: text(view.logic, 260) || item.logic,
      action: text(view.action, 220) || item.action,
      evidenceIds: validEvidenceIds(view.evidenceIds, evidence),
    }
  })
}

function defaultOverview(session, data) {
  const top = data?.sectorFlow?.top?.[0]
  const market = data?.market || {}
  if (session === 'morning') {
    const overseas = [...(data?.overseas || []), ...(data?.commodities || [])]
      .slice(0, 3)
      .map((item) => `${item.label}${numberOrNull(item.pct) == null ? '' : `${numberOrNull(item.pct) >= 0 ? '+' : ''}${numberOrNull(item.pct)}%`}`)
      .join('、')
    return overseas
      ? `隔夜先看${overseas}的A股映射，开盘以竞价和资金承接二次确认。`
      : '隔夜硬数据不足，开盘前不预设方向，以竞价和资金承接确认。'
  }
  const volume = numberOrNull(market.amountYi)
  const leader = top?.name
  if (session === 'noon') {
    return `${volume == null ? '上午成交额暂缺' : `上午两市成交额${volume}亿元`}${leader ? `，主力资金当前优先流向${leader}` : ''}；午后只执行已获盘面确认的方向。`
  }
  return `${volume == null ? '全天成交额暂缺' : `全天两市成交额${volume}亿元`}${leader ? `，资金主线为${leader}` : ''}；次日预案以收盘事实为基准。`
}

function defaultStrategy(session) {
  if (session === 'morning') {
    return '先验证隔夜传导、竞价强弱和板块资金，再按候选池关键价位执行；高开脱离计划区间不追。'
  }
  if (session === 'noon') {
    return '午后保留已确认方向，证伪方向停止新增风险；量价背离时以观望或减仓为主。'
  }
  return '次日优先跟踪收盘主线的延续性；龙虎榜只作资金结构证据，不把单日席位行为直接外推。'
}

function commonResult({
  day,
  session,
  evidence,
  data,
  draft,
  hardData,
  analysis,
  generation,
}) {
  const meta = SESSION_META[session]
  const generatedRisks = Array.isArray(draft?.risks)
    ? draft.risks.map((item) => text(item, 140)).filter(Boolean).slice(0, 4)
    : []
  return {
    schemaVersion: DAILY_REPORT_SCHEMA_VERSION,
    day: text(day, 16),
    session,
    sessionCn: session === 'morning'
      ? '盘前早报'
      : session === 'noon' ? '盘中午报' : '盘后晚报',
    template: meta.template,
    report: {
      objective: meta.objective,
      overview: text(draft?.overview, session === 'morning' ? 520 : 360)
        || defaultOverview(session, data),
      hardData,
      analysis,
      strategy: text(draft?.strategy, session === 'morning' ? 520 : 360)
        || defaultStrategy(session),
      risks: generatedRisks.length
        ? generatedRisks
        : [
            '外部消息与搜索摘要需回到原始披露核验，不能单独触发交易。',
            '计划仅在行情时效与触发条件仍有效时执行。',
          ],
      disclaimer: DISCLAIMER,
    },
    evidence,
    degraded: generation?.complete === false || !draft,
    generation: {
      complete: generation?.complete === true,
      attempts: Number(generation?.attempts) || 0,
      diagnostics: Array.isArray(generation?.diagnostics)
        ? generation.diagnostics
        : [],
    },
  }
}

function morningReport(options) {
  const { day, evidence, data, draft, generation } = options
  const pools = data?.candidatePools || {
    sectors: [],
    stocks: [],
  }
  const transmission = boundedRows(draft?.transmission, 5).map((item) => ({
    signal: text(item.signal, 80),
    reasoning: text(item.reasoning, 240),
    action: text(item.action, 180),
    dataRefs: ['overseas-market'],
    evidenceIds: validEvidenceIds(item.evidenceIds, evidence),
  }))
  const fallbackTransmission = [
    ...(data?.overseas || []),
    ...(data?.commodities || []),
  ].slice(0, 5).map((item) => ({
    signal: `${text(item.label, 40)}${numberOrNull(item.pct) == null ? '' : `${numberOrNull(item.pct) >= 0 ? '+' : ''}${numberOrNull(item.pct)}%`}`,
    reasoning: '作为隔夜风险偏好或成本端线索，需等待A股竞价与板块资金确认。',
    action: '仅建立观察方向，不因单一海外资产波动直接交易。',
    dataRefs: ['overseas-market'],
    evidenceIds: [],
  }))
  const analysis = {
    transmission: transmission.length ? transmission : fallbackTransmission,
    catalysts: evidenceEvents(
      evidence,
      ['macro', 'industry'],
      6,
    ),
    institutionFocus: evidenceEvents(
      evidence,
      ['institution'],
      4,
    ),
    sectorPool: mergePoolViews(
      boundedRows(pools.sectors, 4),
      draft?.sectorViews,
      'name',
      evidence,
    ),
    stockPool: mergePoolViews(
      boundedRows(pools.stocks, 6),
      draft?.stockViews,
      'code',
      evidence,
    ),
    openingPlan: text(draft?.openingPlan, 360)
      || '竞价后先检查候选板块是否有资金承接，再检查个股是否进入计划价区；两项不同时满足则观望。',
  }
  return commonResult({
    day,
    session: 'morning',
    evidence,
    data,
    draft,
    generation,
    hardData: {
      asOf: text(data?.asOf, 32),
      overseas: boundedRows(data?.overseas, 8),
      commodities: boundedRows(data?.commodities, 6),
      sectorForecast: {
        source: text(pools.source, 80),
        signalDate: text(pools.signalDate, 16),
        generatedAt: numberOrNull(pools.generatedAt),
        dataAsOf: text(pools.dataAsOf, 32),
      },
    },
    analysis,
  })
}

function fallbackAfternoonActions(data, review) {
  const actions = []
  for (const item of review.slice(0, 4)) {
    actions.push({
      target: item.subject,
      action: item.status === 'confirmed'
        ? '观望'
        : item.status === 'invalidated' ? '减' : '观望',
      condition: item.status === 'confirmed'
        ? '午后资金继续净流入且价格不破上午承接区时，才考虑按原计划执行。'
        : item.status === 'invalidated'
          ? '停止新增风险，已有仓位反抽无量时优先降低暴露。'
          : '等待价格与资金同向后再决策。',
      invalidation: '主力资金方向反转或价格跌破上午关键低点。',
      dataRefs: ['morning-review', 'sector-flow'],
      evidenceIds: [],
    })
  }
  if (!actions.length && data?.sectorFlow?.top?.[0]) {
    actions.push({
      target: text(data.sectorFlow.top[0].name, 40),
      action: '观望',
      condition: '午后主力净流入延续且龙头未出现量价背离时再关注。',
      invalidation: '资金转为净流出。',
      dataRefs: ['sector-flow'],
      evidenceIds: [],
    })
  }
  return actions
}

function noonReport(options) {
  const { day, evidence, data, draft, generation, morningReport: baseline } =
    options
  const review = evaluateMorningPredictions(baseline, data)
  const generatedActions = boundedRows(draft?.afternoonActions, 5)
    .map((item) => ({
      target: text(item.target, 48),
      action: ['加', '减', '观望'].includes(item.action)
        ? item.action
        : '观望',
      condition: text(item.condition, 220),
      invalidation: text(item.invalidation, 180),
      dataRefs: ['morning-review', 'sector-flow', 'eastmoney-movers'],
      evidenceIds: validEvidenceIds(item.evidenceIds, evidence),
    }))
    .filter((item) => item.target && item.condition)
  const movers = [
    ...(data?.movers?.inflow || []),
    ...(data?.movers?.speed || []),
  ]
  const seen = new Set()
  const normalizedMovers = movers
    .filter((item) => {
      const code = text(item?.code, 12)
      if (!code || seen.has(code)) return false
      seen.add(code)
      return true
    })
    .slice(0, 6)
    .map(normalizedMover)
  return commonResult({
    day,
    session: 'noon',
    evidence,
    data,
    draft,
    generation,
    hardData: {
      asOf: text(data?.asOf, 32),
      market: data?.market || {},
      sectorFlowTop5: boundedRows(data?.sectorFlow?.top, 5),
      sectorFlowBottom3: boundedRows(data?.sectorFlow?.bottom, 3),
      movers: normalizedMovers,
    },
    analysis: {
      morningReview: review,
      afternoonActions: generatedActions.length
        ? generatedActions
        : fallbackAfternoonActions(data, review),
    },
  })
}

function eveningReport(options) {
  const { day, evidence, data, draft, generation, morningReport: baseline } =
    options
  const review = evaluateMorningPredictions(baseline, data)
  const mainlines = boundedRows(data?.sectorFlow?.top, 4).map((item) => ({
    name: text(item.name, 40),
    pct: numberOrNull(item.pct),
    inflowYi: numberOrNull(item.inflowYi),
    conclusion: numberOrNull(item.inflowYi) > 0
      ? '收盘涨幅与主力净流入共同构成当日主线证据。'
      : '涨幅缺少资金配合，暂按轮动而非主线处理。',
    dataRefs: ['sector-flow'],
    evidenceIds: [],
  }))
  const generatedPlan = boundedRows(draft?.nextDayPlan, 5)
    .map((item) => ({
      target: text(item.target, 48),
      action: text(item.action, 180),
      trigger: text(item.trigger, 180),
      invalidation: text(item.invalidation, 180),
      dataRefs: ['closing-market', 'morning-review'],
      evidenceIds: validEvidenceIds(item.evidenceIds, evidence),
    }))
    .filter((item) => item.target && item.action)
  const nextDayPlan = generatedPlan.length
    ? generatedPlan
    : mainlines.slice(0, 3).map((item) => ({
        target: item.name,
        action: '观察次日竞价承接，不追一致性高开。',
        trigger: '板块资金继续净流入且龙头不破开盘承接区。',
        invalidation: '资金转为净流出或龙头率先走弱。',
        dataRefs: ['sector-flow'],
        evidenceIds: [],
      }))
  return commonResult({
    day,
    session: 'evening',
    evidence,
    data,
    draft,
    generation,
    hardData: {
      asOf: text(data?.asOf, 32),
      market: data?.market || {},
      sectorFlowTop5: boundedRows(data?.sectorFlow?.top, 5),
      sectorFlowBottom3: boundedRows(data?.sectorFlow?.bottom, 3),
      lhb: normalizedLhb(data?.lhb),
      northbound: normalizeNorthboundDisclosure(data?.northbound),
    },
    analysis: {
      morningReview: review,
      mainlines,
      nextDayPlan,
      overseasWatch: boundedRows(draft?.overseasWatch, 5).map((item) => ({
        event: text(item.event, 140),
        watch: text(item.watch, 200),
        dataRefs: ['web-evidence'],
        evidenceIds: validEvidenceIds(item.evidenceIds, evidence),
      })),
    },
  })
}

export function buildDailyReportV3(options = {}) {
  const session = SESSION_META[options.session] ? options.session : 'morning'
  if (session === 'noon') return noonReport({ ...options, session })
  if (session === 'evening') return eveningReport({ ...options, session })
  return morningReport({ ...options, session })
}

export function isValuableDailyReportV3(result) {
  const report = result?.report
  if (!text(report?.overview) || !text(report?.strategy)) return false
  const hasEvidence = Number(result?.evidence?.stats?.total) > 0
  if (result?.session === 'morning') {
    return !!(
      report?.analysis?.sectorPool?.length
      || report?.analysis?.stockPool?.length
      || report?.analysis?.catalysts?.length
      || hasEvidence
    )
  }
  if (result?.session === 'noon') {
    return !!(
      report?.hardData?.sectorFlowTop5?.length
      || report?.hardData?.movers?.length
      || report?.analysis?.morningReview?.length
      || hasEvidence
    )
  }
  return !!(
    report?.hardData?.sectorFlowTop5?.length
    || report?.hardData?.lhb?.stocks?.length
    || report?.hardData?.northbound?.totalTurnoverYi != null
    || report?.analysis?.morningReview?.length
    || hasEvidence
  )
}
