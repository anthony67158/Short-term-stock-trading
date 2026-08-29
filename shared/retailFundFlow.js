const finite = (value) => {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const day = (value) => String(value || '').slice(0, 10)

export const RETAIL_FLOW_CAVEAT =
  '小单资金仅按成交规模分类，是散户行为代理，不等于真实账户身份；拆单、对倒和涨跌停成交机制都可能造成偏差。'

export function buildRetailFlowEvidence(input = {}) {
  const mainNetYi = finite(input.mainNetYi)
  const retailNetYi = finite(
    input.retailNetYi ?? input.smallNetYi,
  )
  if (mainNetYi == null && retailNetYi == null) return null

  let relation = 'partial'
  let bias = 'neutral'
  let interpretation = '主力或小单资金数据不完整，不能判断资金结构。'
  let confirmation = '等待主力与小单数据齐备，并结合价格、量能和位置确认。'

  if (mainNetYi != null && retailNetYi != null) {
    if (mainNetYi > 0 && retailNetYi < 0) {
      relation = 'main_in_retail_out'
      bias = 'constructive'
      interpretation = '大单主动买入、小单主动卖出，可能是大单承接小单抛压、筹码向强手集中。'
      confirmation = '只有价格走强且量能健康时才偏正面；若放量不涨或冲高回落，需防对倒和诱多。'
    } else if (mainNetYi < 0 && retailNetYi > 0) {
      relation = 'main_out_retail_in'
      bias = 'risk'
      interpretation = '大单主动卖出、小单主动买入，可能是小单承接大单抛压、散户追涨接盘。'
      confirmation = '处于高位、放量或冲高回落时风险更高；低位企稳时仍需结合后续承接确认。'
    } else if (mainNetYi > 0 && retailNetYi > 0) {
      relation = 'broad_inflow'
      bias = 'constructive'
      interpretation = '大单与小单同步主动买入，说明买盘参与较广。'
      confirmation = '需用价格上涨和量能延续确认；高换手冲高回落时可能已接近情绪高潮。'
    } else if (mainNetYi < 0 && retailNetYi < 0) {
      relation = 'broad_outflow'
      bias = 'risk'
      interpretation = '大单与小单同步主动卖出，说明抛压较广。'
      confirmation = '若同时放量下跌或跌破支撑，风险信号更强；缩量企稳时再观察是否止跌。'
    } else {
      relation = 'flat_or_divergent'
      interpretation = '主力或小单净额接近零，资金方向暂不明确。'
    }
  }

  return {
    schemaVersion: 'retail-flow-evidence.v1',
    mainNetYi,
    retailNetYi,
    relation,
    bias,
    interpretation,
    confirmation,
    caveat: RETAIL_FLOW_CAVEAT,
    asOfDate: input.asOfDate || null,
    isHistorical: input.isHistorical === true,
    priceContext: {
      pct: finite(input.pct),
      turnover: finite(input.turnover),
      volRatio: finite(input.volRatio),
    },
  }
}

export function mergeRetailFundFlow(
  stockFund,
  todayQuote,
) {
  const base = stockFund && typeof stockFund === 'object'
    ? { ...stockFund }
    : null
  const quoteMain = finite(todayQuote?.mainNetYi)
  const quoteRetail = finite(todayQuote?.retailNetYi)
  const quoteMain5d = finite(todayQuote?.main5dYi)
  const quoteRetail5d = finite(todayQuote?.retail5dYi)
  const quoteDate = day(
    todayQuote?.tradeDate || todayQuote?.asOfLabel,
  )
  const baseDate = day(
    base?.asOfDate || base?.historicalAsOfDate,
  )
  const quoteAligned = !!quoteDate
    && (!baseDate || quoteDate === baseDate)
  const useQuoteDaily = (
    todayQuote?.live === true || quoteAligned
  ) && (quoteMain != null || quoteRetail != null)
  const useQuoteFiveDay = quoteAligned
    && (quoteMain5d != null || quoteRetail5d != null)
  const completeHistory = base?.historyComplete === true
    && stockFundHistoryDayCount(base) >= 5

  if (!base && !useQuoteDaily && !useQuoteFiveDay) return null

  const merged = {
    ...(base || {}),
    ...(!base ? {
      schemaVersion: 'stock-fund-snapshot.v1',
      source: todayQuote?.source || 'quote',
      historyDayCount: 0,
      historyComplete: false,
      mainTrend5: [],
      retailTrend5: [],
    } : {}),
    ...(useQuoteDaily ? {
      asOfDate: quoteDate || base?.asOfDate || null,
      historicalAsOfDate: todayQuote?.live === true
        ? base?.historicalAsOfDate || null
        : quoteDate || base?.historicalAsOfDate || null,
      isHistorical: todayQuote?.live !== true,
      mainNetYi: quoteMain,
      smallNetYi: quoteRetail,
      retailNetYi: quoteRetail,
    } : {
      retailNetYi: finite(
        base?.retailNetYi ?? base?.smallNetYi,
      ),
    }),
    ...(useQuoteFiveDay && !completeHistory ? {
      ...(quoteMain5d != null ? { main5dYi: quoteMain5d } : {}),
      ...(quoteRetail5d != null
        ? { retail5dYi: quoteRetail5d }
        : {}),
      fiveDaySource: 'quote-aggregate',
    } : completeHistory ? {
      fiveDaySource: base?.fiveDaySource || 'daily-history',
    } : {}),
  }
  const comparableQuote = useQuoteDaily || useQuoteFiveDay

  merged.retailFlow = buildRetailFlowEvidence({
    ...merged,
    pct: comparableQuote ? todayQuote?.pct : null,
    turnover: comparableQuote ? todayQuote?.turnover : null,
    volRatio: comparableQuote ? todayQuote?.volRatio : null,
  })
  return merged
}

function compactTrend(value) {
  return (Array.isArray(value) ? value : [])
    .slice(-5)
    .map(finite)
}

export function stockFundHistoryDayCount(input = {}) {
  const mainTrend = compactTrend(
    input?.mainTrend5 ?? input?.trend5,
  )
  const retailTrend = compactTrend(input?.retailTrend5)
  return Math.max(
    0,
    Math.min(
      5,
      Number(input?.historyDayCount)
      || Math.max(mainTrend.length, retailTrend.length),
    ),
  )
}

export function normalizeFundNoteHistory(note, stockFund = {}) {
  const text = String(note || '').trim()
  if (!text) return text
  const historyDays = stockFundHistoryDayCount(stockFund)
  if (historyDays >= 5) return text
  const hasFiveDayAggregate = (
    finite(stockFund?.main5dYi) != null
    || finite(stockFund?.retail5dYi) != null
  )
  const label = historyDays > 0
    ? `当前${historyDays}个交易日`
    : '当前可用历史'
  const normalized = hasFiveDayAggregate
    ? text.replace(
        /(?:最近|近)\s*5\s*日(?=\s*(?:序列|逐日|连续))/g,
        label,
      )
    : text.replace(/(?:最近|近)\s*5\s*日/g, label)
  const caveat = hasFiveDayAggregate
    ? historyDays > 0
      ? `已取得5日累计，但逐日资金仅取得${historyDays}个交易日，不能据此判断逐日连续性。`
      : '已取得5日累计，但逐日资金序列缺失，不能据此判断逐日连续性。'
    : historyDays > 0
      ? `历史资金仅取得${historyDays}个交易日，不能据此判断5日持续性。`
      : '历史资金序列缺失，不能据此判断5日持续性。'
  return (
    normalized.includes('不能据此判断5日持续性')
    || normalized.includes('不能据此判断逐日连续性')
  )
    ? normalized
    : `${normalized.replace(/[。；]\s*$/, '')}；${caveat}`
}

function flowAmountText(label, value) {
  const amount = finite(value)
  if (amount == null) return `${label}缺失`
  if (amount === 0) return `${label}净额0亿元`
  return `${label}${amount > 0 ? '净流入' : '净流出'}${Math.abs(amount)}亿元`
}

function flowRelationText(mainNetYi, retailNetYi) {
  if (mainNetYi == null || retailNetYi == null) {
    return '资金结构不完整，不能据此判断方向'
  }
  if (mainNetYi < 0 && retailNetYi > 0) {
    return '当日主力流出、小单流入，需警惕小单承接抛压'
  }
  if (mainNetYi > 0 && retailNetYi < 0) {
    return '当日主力流入、小单流出，需结合价格和量能确认承接'
  }
  if (mainNetYi > 0 && retailNetYi > 0) {
    return '当日主力与小单同步流入，仍需价格和量能确认'
  }
  if (mainNetYi < 0 && retailNetYi < 0) {
    return '当日主力与小单同步流出，抛压偏强'
  }
  return '当日资金方向接近平衡'
}

export function buildStockFundNote(input = {}) {
  const mainNetYi = finite(input.mainNetYi)
  const retailNetYi = finite(
    input.retailNetYi ?? input.smallNetYi,
  )
  const main5dYi = finite(input.main5dYi)
  const retail5dYi = finite(input.retail5dYi)
  if (
    mainNetYi == null
    && retailNetYi == null
    && main5dYi == null
    && retail5dYi == null
  ) return ''
  const mainTrend = compactTrend(input.mainTrend5 ?? input.trend5)
  const retailTrend = compactTrend(input.retailTrend5)
  const historyDays = stockFundHistoryDayCount(input)
  const complete = historyDays >= 5
    && mainTrend.length >= 5
    && retailTrend.length >= 5
    && mainTrend.every((value) => value != null)
    && retailTrend.every((value) => value != null)
  const parts = [
    flowAmountText('主力当日', mainNetYi),
    flowAmountText('小单资金代理当日', retailNetYi),
  ]
  if (complete) {
    const completeMain5dYi = main5dYi
      ?? +mainTrend.reduce((sum, value) => sum + value, 0).toFixed(2)
    const completeRetail5dYi = retail5dYi
      ?? +retailTrend.reduce((sum, value) => sum + value, 0).toFixed(2)
    parts.push(
      `最近5日主力[${mainTrend.join(',')}]`,
      `小单资金代理[${retailTrend.join(',')}]`,
      flowAmountText('5日合计主力', completeMain5dYi),
      flowAmountText('小单资金代理', completeRetail5dYi),
    )
  } else if (main5dYi != null || retail5dYi != null) {
    parts.push(
      flowAmountText('5日累计主力', main5dYi),
      flowAmountText('5日累计小单资金代理', retail5dYi),
      historyDays > 0
        ? `逐日资金仅取得${historyDays}个交易日，不能判断逐日连续性`
        : '逐日资金序列缺失，不能判断逐日连续性',
    )
  } else {
    parts.push(
      historyDays > 0
        ? `当前仅取得${historyDays}个交易日历史，不能判断5日持续性`
        : '历史资金序列缺失，不能判断5日持续性',
    )
  }
  parts.push(
    flowRelationText(mainNetYi, retailNetYi),
    '小单资金代理不等于真实账户身份，不能单独作为买卖信号',
  )
  return `${parts.join('；')}。`
}

export function compactStockFundSnapshot(input = {}) {
  if (!input || typeof input !== 'object') return null
  const mainNetYi = finite(input.mainNetYi)
  const retailNetYi = finite(
    input.retailNetYi ?? input.smallNetYi,
  )
  const main5dYi = finite(input.main5dYi)
  const retail5dYi = finite(input.retail5dYi)
  if (
    mainNetYi == null
    && retailNetYi == null
    && main5dYi == null
    && retail5dYi == null
  ) return null
  const mainTrend5 = compactTrend(
    input.mainTrend5 ?? input.trend5,
  )
  const retailTrend5 = compactTrend(input.retailTrend5)
  const historyDayCount = stockFundHistoryDayCount(input)
  return {
    schemaVersion: 'stock-fund-snapshot.v1',
    source: String(input.source || (
      input.isHistorical ? 'historical' : 'realtime'
    )).slice(0, 30),
    fetchedAt: finite(input.fetchedAt),
    asOfDate: input.asOfDate || null,
    historicalAsOfDate: input.historicalAsOfDate || null,
    isHistorical: input.isHistorical === true,
    mainNetYi,
    retailNetYi,
    main5dYi,
    retail5dYi,
    fiveDaySource: String(input.fiveDaySource || '').slice(0, 30),
    main5dAvgYi: finite(input.main5dAvgYi),
    retail5dAvgYi: finite(input.retail5dAvgYi),
    historyDayCount,
    historyComplete:
      input.historyComplete === true || historyDayCount >= 5,
    inflowDays: finite(input.inflowDays),
    retailInflowDays: finite(input.retailInflowDays),
    mainStreak: finite(input.mainStreak),
    retailStreak: finite(input.retailStreak),
    mainTrend5,
    retailTrend5,
    retailFlow: input.retailFlow
      ? {
          relation: input.retailFlow.relation || 'partial',
          bias: input.retailFlow.bias || 'neutral',
          interpretation: input.retailFlow.interpretation || '',
        }
      : buildRetailFlowEvidence({
          mainNetYi,
          retailNetYi,
          asOfDate: input.asOfDate,
          isHistorical: input.isHistorical,
        }),
  }
}

function directionChange(current, baseline, label) {
  if (current == null) return `${label}当前缺失`
  if (baseline == null) {
    return `${label}当前${current > 0 ? '净流入' : current < 0 ? '净流出' : '接近平衡'}`
  }
  if (baseline <= 0 && current > 0) return `${label}由流出转流入`
  if (baseline >= 0 && current < 0) return `${label}由流入转流出`
  const delta = +(current - baseline).toFixed(2)
  if (Math.abs(delta) < 0.05) return `${label}基本持平`
  return `${label}${delta > 0 ? '增强' : '减弱'}${Math.abs(delta)}亿元`
}

export function compareStockFundSnapshots(currentInput, baselineInput) {
  const current = compactStockFundSnapshot(currentInput)
  const baseline = compactStockFundSnapshot(baselineInput)
  if (!current) {
    return {
      status: 'UNAVAILABLE',
      baselineAvailable: !!baseline,
      summary: '本次未取得有效的最新主力与散户资金快照',
    }
  }
  const mainDeltaYi = current.mainNetYi == null
    || baseline?.mainNetYi == null
    ? null
    : +(current.mainNetYi - baseline.mainNetYi).toFixed(2)
  const retailDeltaYi = current.retailNetYi == null
    || baseline?.retailNetYi == null
    ? null
    : +(current.retailNetYi - baseline.retailNetYi).toFixed(2)
  const relationChanged = !!(
    baseline?.retailFlow?.relation
    && current.retailFlow?.relation
    && baseline.retailFlow.relation !== current.retailFlow.relation
  )
  return {
    status: baseline ? 'COMPARED' : 'FRESH_ONLY',
    baselineAvailable: !!baseline,
    mainDeltaYi,
    retailDeltaYi,
    relationChanged,
    summary: [
      directionChange(
        current.mainNetYi,
        baseline?.mainNetYi,
        '主力',
      ),
      directionChange(
        current.retailNetYi,
        baseline?.retailNetYi,
        '散户代理',
      ),
      relationChanged ? '主力与散户关系已变化' : '',
    ].filter(Boolean).join('；'),
  }
}
