import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DAILY_REPORT_SCHEMA_VERSION,
  buildDailyReportV3,
  buildMorningCandidatePools,
  evaluateMorningPredictions,
  normalizeNorthboundDisclosure,
} from '../api/_daily_report_v3.js'

const EVIDENCE = {
  items: [
    {
      id: 'E01',
      category: 'global',
      title: '美股科技板块隔夜走强',
      summary: '纳斯达克指数收涨。',
      src: 'Reuters',
      publishedAt: '2026-08-23T21:10:00Z',
      evidenceLevel: 'corroborated',
    },
    {
      id: 'E02',
      category: 'macro',
      title: '主管部门发布产业支持政策',
      summary: '政策原文已公开。',
      src: '中国政府网',
      publishedAt: '2026-08-24T00:10:00Z',
      evidenceLevel: 'primary',
    },
  ],
  stats: { total: 2 },
}

const SECTOR_FORECAST = {
  signalDate: '2026-08-23',
  generatedAt: Date.parse('2026-08-23T07:10:00Z'),
  dataAsOf: '2026-08-23 15:10',
  sectors: [{
    code: 'BK1036',
    name: '半导体',
    rank: 1,
    actionability: 'LAYOUT',
    forecast: {
      next: { probability: 0.68 },
      week: { probability: 0.64 },
    },
    explanation: {
      whyNow: '行业催化与资金结构共振。',
      risks: ['高开后承接不足。'],
    },
    stocks: [{
      code: '688981',
      name: '中芯国际',
      role: 'leader',
      price: 99.2,
      pct: 1.6,
      mainInflow: 260000000,
    }],
  }],
}

const TECHNICALS = {
  '688981': {
    price: 99.2,
    maTrend: 'bull',
    sr: { support: 96.8, resistance: 104.5 },
    priceHints: {
      buyZone: { low: 96.8, high: 98.3 },
      sellZone: { low: 103.6, high: 105.2 },
      stopLoss: 94.9,
      takeProfit: 106.1,
    },
  },
}

test('盘前报告使用预判预案模板并保留确定性关键价位', () => {
  const pools = buildMorningCandidatePools({
    sectorForecast: SECTOR_FORECAST,
    technicalsByCode: TECHNICALS,
  })
  const result = buildDailyReportV3({
    day: '2026-08-24',
    session: 'morning',
    evidence: EVIDENCE,
    data: {
      asOf: '2026-08-24 08:20',
      overseas: [{ label: '纳斯达克', pct: 1.1 }],
      commodities: [{ label: '美原油(WTI)', pct: -0.7 }],
      candidatePools: pools,
    },
    draft: {
      overview: '隔夜科技风险偏好改善，但开盘仍需验证承接。[E01]',
      sectorViews: [{
        name: '半导体',
        logic: '海外映射与产业政策形成双催化。[E01][E02]',
        action: '只在回踩承接有效时关注，不追高。',
        evidenceIds: ['E01', 'E02'],
      }],
      stockViews: [{
        code: '688981',
        logic: '板块龙头，适合作为强弱观察锚。',
        action: '回踩买入区企稳后关注。',
        evidenceIds: ['E01'],
        pricePlan: { buyZone: { low: 1, high: 2 }, stopLoss: 0.5 },
      }],
      strategy: '竞价确认后再执行。',
    },
  })

  assert.equal(result.schemaVersion, DAILY_REPORT_SCHEMA_VERSION)
  assert.equal(result.template, 'morning-plan')
  assert.equal(result.report.objective, '预判与预案')
  assert.equal(result.report.analysis.sectorPool.length, 1)
  assert.equal(result.report.analysis.stockPool.length, 1)
  assert.deepEqual(
    result.report.analysis.stockPool[0].pricePlan,
    TECHNICALS['688981'].priceHints,
  )
  assert.equal(
    result.report.analysis.stockPool[0].priceBasis,
    'QFQ日线参考',
  )
  assert.equal(result.report.analysis.morningReview, undefined)
  assert.match(result.report.disclaimer, /不构成投资建议/)
})

test('午报按上午资金对早报逐项确认和证伪', () => {
  const morningReport = {
    report: {
      analysis: {
        sectorPool: [
          { name: '半导体', action: '回踩承接后关注。' },
          { name: '光伏设备', action: '只观察弱转强。' },
        ],
      },
    },
  }
  const review = evaluateMorningPredictions(morningReport, {
    sectorFlow: {
      top: [{ name: '半导体', pct: 2.1, inflowYi: 35.2 }],
      bottom: [{ name: '光伏设备', pct: -2.4, inflowYi: -18.6 }],
    },
  })

  assert.deepEqual(
    review.map((item) => item.status),
    ['confirmed', 'invalidated'],
  )

  const result = buildDailyReportV3({
    day: '2026-08-24',
    session: 'noon',
    evidence: EVIDENCE,
    morningReport,
    data: {
      asOf: '2026-08-24 11:35',
      market: {
        amountYi: 6420,
        volVsAvg5: 8.2,
        volLevel: '平量',
      },
      sectorFlow: {
        top: [
          { name: '半导体', pct: 2.1, inflowYi: 35.2 },
          { name: '银行', pct: 1.2, inflowYi: 18.4 },
          { name: '通信设备', pct: 1.4, inflowYi: 13.5 },
          { name: '软件开发', pct: 1.1, inflowYi: 11.8 },
          { name: '证券', pct: 0.8, inflowYi: 9.7 },
          { name: '消费电子', pct: 0.6, inflowYi: 8.1 },
        ],
        bottom: [{ name: '光伏设备', pct: -2.4, inflowYi: -18.6 }],
      },
      movers: {
        inflow: [{ code: '688981', name: '中芯国际', pct: 3.2, mainInflow: 520000000 }],
        speed: [{ code: '300308', name: '中际旭创', pct: 4.1, speed: 1.2 }],
      },
    },
  })

  assert.equal(result.template, 'noon-correction')
  assert.equal(result.report.objective, '确认与纠偏')
  assert.equal(result.report.hardData.sectorFlowTop5.length, 5)
  assert.equal(result.report.analysis.morningReview[1].status, 'invalidated')
  assert.ok(result.report.analysis.afternoonActions.length > 0)
  assert.equal(result.report.analysis.stockPool, undefined)
})

test('盘后报告复盘早报并使用真实龙虎榜与北向披露口径', () => {
  const northbound = normalizeNorthboundDisclosure({
    date: '2026-08-24',
    totalTurnoverYi: 1382.6,
    shTurnoverYi: 712.1,
    szTurnoverYi: 670.5,
    dealCount: 13529157,
    netBuyYi: 0,
    topStocks: [{
      code: '600519',
      name: '贵州茅台',
      turnoverYi: 18.2,
    }],
  })
  assert.equal(northbound.netBuyYi, null)
  assert.equal(northbound.netBuyDisclosure, '未披露')
  assert.equal(northbound.dealCount, 13529157)

  const result = buildDailyReportV3({
    day: '2026-08-24',
    session: 'evening',
    evidence: EVIDENCE,
    morningReport: {
      report: {
        analysis: {
          sectorPool: [{ name: '半导体', action: '回踩承接后关注。' }],
        },
      },
    },
    data: {
      asOf: '2026-08-24 15:20',
      market: { amountYi: 10580, volVsAvg5: 12.4, volLevel: '平量' },
      sectorFlow: {
        top: [{ name: '半导体', pct: 2.8, inflowYi: 48.1 }],
        bottom: [],
      },
      lhb: {
        date: '2026-08-24',
        stocks: [{
          code: '000001',
          name: '平安银行',
          net: 180000000,
          reason: '日涨幅偏离值达到7%',
        }],
        seats: [{ alias: '机构专用', name: '机构专用', net: 96000000 }],
      },
      northbound,
    },
  })

  assert.equal(result.template, 'evening-review')
  assert.equal(result.report.objective, '复盘与次日预判')
  assert.equal(result.report.hardData.lhb.stocks.length, 1)
  assert.equal(result.report.hardData.northbound.netBuyYi, null)
  assert.equal(result.report.analysis.morningReview[0].status, 'confirmed')
  assert.ok(Array.isArray(result.report.analysis.nextDayPlan))
  assert.equal(result.report.analysis.afternoonActions, undefined)
})

test('三场模板按信息密度限制数组长度', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    name: `板块${index}`,
    pct: index,
    inflowYi: 20 - index,
  }))
  const noon = buildDailyReportV3({
    session: 'noon',
    evidence: EVIDENCE,
    data: {
      sectorFlow: { top: many, bottom: [] },
      movers: {
        inflow: many.map((item, index) => ({
          code: String(index).padStart(6, '0'),
          ...item,
        })),
      },
    },
  })
  const evening = buildDailyReportV3({
    session: 'evening',
    evidence: EVIDENCE,
    data: {
      sectorFlow: { top: many, bottom: [] },
      lhb: {
        stocks: many.map((item, index) => ({
          code: String(index).padStart(6, '0'),
          ...item,
        })),
      },
    },
  })

  assert.equal(noon.report.hardData.sectorFlowTop5.length, 5)
  assert.ok(noon.report.hardData.movers.length <= 6)
  assert.ok(evening.report.hardData.lhb.stocks.length <= 8)
})
