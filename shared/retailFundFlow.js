const finite = (value) => {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

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
  const liveMain = finite(todayQuote?.mainNetYi)
  const liveRetail = finite(todayQuote?.retailNetYi)
  const hasLiveQuote = todayQuote?.live === true
    && (liveMain != null || liveRetail != null)

  if (!base && !hasLiveQuote) return null

  const merged = {
    ...(base || {}),
    ...(hasLiveQuote ? {
      asOfDate: todayQuote?.asOfLabel || base?.asOfDate || null,
      isHistorical: false,
      mainNetYi: liveMain,
      smallNetYi: liveRetail,
      retailNetYi: liveRetail,
    } : {
      retailNetYi: finite(
        base?.retailNetYi ?? base?.smallNetYi,
      ),
    }),
  }
  const comparableQuote = hasLiveQuote
    || (
      todayQuote?.asOfLabel
      && todayQuote.asOfLabel === merged.asOfDate
    )

  merged.retailFlow = buildRetailFlowEvidence({
    ...merged,
    pct: comparableQuote ? todayQuote?.pct : null,
    turnover: comparableQuote ? todayQuote?.turnover : null,
    volRatio: comparableQuote ? todayQuote?.volRatio : null,
  })
  return merged
}
