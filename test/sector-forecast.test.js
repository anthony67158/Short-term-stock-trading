import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SECTOR_FORECAST_SCHEMA_VERSION,
  buildSectorForecastFeatures,
  labelSectorForecastOutcomes,
  mergeSectorForecastExplanation,
  rankSectorForecasts,
  scoreSectorForecast,
  summarizeSectorForecastOutcomes,
} from '../shared/sectorForecast.js'

function history(overrides = {}) {
  return [
    { date: '2026-08-07', mainInflow: 50e6, mainRatio: 0.8, close: 100, pct: 0.2 },
    { date: '2026-08-10', mainInflow: 80e6, mainRatio: 1.1, close: 100.3, pct: 0.3 },
    { date: '2026-08-11', mainInflow: 110e6, mainRatio: 1.5, close: 100.5, pct: 0.2 },
    { date: '2026-08-12', mainInflow: 150e6, mainRatio: 2, close: 100.8, pct: 0.3 },
    { date: '2026-08-13', mainInflow: 210e6, mainRatio: 2.8, close: 101, pct: 0.2 },
    { date: '2026-08-14', mainInflow: 280e6, mainRatio: 3.6, close: 101.4, pct: 0.4 },
    { date: '2026-08-17', mainInflow: 360e6, mainRatio: 4.5, close: 101.7, pct: 0.3 },
    { date: '2026-08-18', mainInflow: 450e6, mainRatio: 5.2, close: 102, pct: 0.3 },
    { date: '2026-08-19', mainInflow: 520e6, mainRatio: 5.8, close: 102.4, pct: 0.4 },
    {
      date: '2026-08-20',
      mainInflow: 620e6,
      mainRatio: 6.5,
      close: 102.8,
      pct: 0.4,
      ...overrides,
    },
  ]
}

function row(patch = {}) {
  return {
    code: 'BK1000',
    name: '机器人',
    pct: 0.4,
    mainInflow: 620e6,
    mainRatio: 6.5,
    amount: 32e9,
    leadCode: '600001',
    leadName: '机器人龙头',
    leadPct: 2.5,
    ...patch,
  }
}

function context(patch = {}) {
  return {
    sectorPercentiles: {
      mainInflow: 0.85,
      mainRatio: 0.82,
      amount: 0.8,
      pct: 0.42,
      leadPct: 0.55,
    },
    breadth: {
      upPct: 64,
      inflowPct: 58,
      limitUpPct: 2,
      memberCount: 30,
    },
    leadership: {
      strength: 76,
      coreHealthy: true,
    },
    market: {
      score: 66,
      riskState: 'RISK_ON',
    },
    ...patch,
  }
}

test('资金持续改善且价格未过热的潜伏板块可布局', () => {
  const features = buildSectorForecastFeatures({
    sector: row(),
    history: history(),
    ...context(),
  })
  const forecast = scoreSectorForecast(features)

  assert.equal(forecast.schemaVersion, SECTOR_FORECAST_SCHEMA_VERSION)
  assert.equal(forecast.phase, 'ACCUMULATION')
  assert.equal(forecast.actionability, 'LAYOUT')
  assert.ok(forecast.forecast.next.score >= 65)
  assert.ok(forecast.forecast.week.score >= 65)
  assert.equal(forecast.penalties.crowding, 0)
  assert.match(forecast.reasons.join(' '), /连续|资金/)
})

test('当日暴涨和涨停扩散触发追高惩罚并禁止可布局', () => {
  const features = buildSectorForecastFeatures({
    sector: row({ pct: 8.6, leadPct: 10 }),
    history: history({ pct: 8.6, close: 111.2 }),
    ...context({
      sectorPercentiles: {
        mainInflow: 0.98,
        mainRatio: 0.96,
        amount: 0.95,
        pct: 0.99,
        leadPct: 0.99,
      },
      breadth: {
        upPct: 96,
        inflowPct: 84,
        limitUpPct: 35,
        memberCount: 40,
      },
      leadership: { strength: 95, coreHealthy: true },
    }),
  })
  const forecast = scoreSectorForecast(features)

  assert.equal(forecast.phase, 'ACCELERATION')
  assert.equal(forecast.actionability, 'WATCH_ONLY')
  assert.ok(forecast.penalties.crowding >= 20)
  assert.match(forecast.risks.join(' '), /过热|追高|涨停/)
})

test('板块上涨但资金转流出识别为分歧且不能布局', () => {
  const features = buildSectorForecastFeatures({
    sector: row({ pct: 3.2, mainInflow: -320e6, mainRatio: -4.5 }),
    history: history({
      pct: 3.2,
      close: 105.3,
      mainInflow: -320e6,
      mainRatio: -4.5,
    }),
    ...context({
      sectorPercentiles: {
        mainInflow: 0.08,
        mainRatio: 0.05,
        amount: 0.8,
        pct: 0.8,
        leadPct: 0.75,
      },
      breadth: {
        upPct: 35,
        inflowPct: 22,
        limitUpPct: 3,
        memberCount: 30,
      },
    }),
  })
  const forecast = scoreSectorForecast(features)

  assert.equal(forecast.phase, 'DIVERGENCE')
  assert.notEqual(forecast.actionability, 'LAYOUT')
  assert.ok(forecast.penalties.divergence > 0)
})

test('排名使用确定性分数且LLM解释不能覆盖排名阶段与动作', () => {
  const strong = scoreSectorForecast(buildSectorForecastFeatures({
    sector: row({ code: 'BK1001', name: '潜伏方向' }),
    history: history(),
    ...context(),
  }))
  const weak = scoreSectorForecast(buildSectorForecastFeatures({
    sector: row({
      code: 'BK1002',
      name: '弱势方向',
      pct: -2,
      mainInflow: -500e6,
      mainRatio: -8,
    }),
    history: history({
      pct: -2,
      mainInflow: -500e6,
      mainRatio: -8,
      close: 99,
    }),
    ...context({
      sectorPercentiles: {
        mainInflow: 0.02,
        mainRatio: 0.02,
        amount: 0.5,
        pct: 0.08,
        leadPct: 0.1,
      },
      breadth: {
        upPct: 18,
        inflowPct: 12,
        limitUpPct: 0,
        memberCount: 30,
      },
      leadership: { strength: 30, coreHealthy: false },
      market: { score: 35, riskState: 'RISK_OFF' },
    }),
  }))
  const ranked = rankSectorForecasts([weak, strong], 'next')
  const explained = mergeSectorForecastExplanation(ranked[0], {
    code: 'BK1001',
    rank: 99,
    phase: 'RETREAT',
    actionability: 'AVOID',
    whyNow: '资金正在提前埋伏。',
    catalysts: ['政策线索'],
    risks: ['需求不及预期'],
    counterCase: '板块可能继续震荡',
    invalidation: '资金连续两日流出',
    injected: '<script>alert(1)</script>',
  })

  assert.equal(ranked[0].code, 'BK1001')
  assert.equal(ranked[0].rank, 1)
  assert.equal(explained.rank, 1)
  assert.equal(explained.phase, strong.phase)
  assert.equal(explained.actionability, strong.actionability)
  assert.equal(explained.explanation.whyNow, '资金正在提前埋伏。')
  assert.equal(explained.injected, undefined)
})

test('T+1和T+5标签按未来横截面排名与超额收益结算', () => {
  const predictions = [{
    signalDate: '2026-08-20',
    sectors: [
      { code: 'BK1', rank: 1 },
      { code: 'BK2', rank: 2 },
      { code: 'BK3', rank: 3 },
      { code: 'BK4', rank: 4 },
      { code: 'BK5', rank: 5 },
    ],
  }]
  const prices = {
    BK1: [
      { date: '2026-08-20', close: 100 },
      { date: '2026-08-21', open: 101, close: 106, low: 100 },
      { date: '2026-08-24', close: 108, low: 104 },
      { date: '2026-08-25', close: 109, low: 105 },
      { date: '2026-08-26', close: 110, low: 106 },
      { date: '2026-08-27', close: 112, low: 107 },
    ],
    BK2: [
      { date: '2026-08-20', close: 100 },
      { date: '2026-08-21', open: 100, close: 102, low: 98 },
      { date: '2026-08-24', close: 101, low: 97 },
      { date: '2026-08-25', close: 100, low: 96 },
      { date: '2026-08-26', close: 99, low: 95 },
      { date: '2026-08-27', close: 101, low: 95 },
    ],
    BK3: [
      { date: '2026-08-20', close: 100 },
      { date: '2026-08-21', open: 100, close: 99, low: 98 },
      { date: '2026-08-24', close: 100, low: 98 },
      { date: '2026-08-25', close: 101, low: 99 },
      { date: '2026-08-26', close: 100, low: 98 },
      { date: '2026-08-27', close: 99, low: 97 },
    ],
    BK4: [
      { date: '2026-08-20', close: 100 },
      { date: '2026-08-21', open: 100, close: 98, low: 97 },
      { date: '2026-08-24', close: 97, low: 95 },
      { date: '2026-08-25', close: 96, low: 94 },
      { date: '2026-08-26', close: 95, low: 93 },
      { date: '2026-08-27', close: 94, low: 92 },
    ],
    BK5: [
      { date: '2026-08-20', close: 100 },
      { date: '2026-08-21', open: 100, close: 97, low: 96 },
      { date: '2026-08-24', close: 95, low: 94 },
      { date: '2026-08-25', close: 94, low: 92 },
      { date: '2026-08-26', close: 93, low: 90 },
      { date: '2026-08-27', close: 91, low: 88 },
    ],
  }

  const outcomes = labelSectorForecastOutcomes(predictions[0], prices)
  const summary = summarizeSectorForecastOutcomes(outcomes, { topK: 2 })

  assert.equal(outcomes[0].nextTopQuintile, true)
  assert.equal(outcomes[0].weekTopQuintile, true)
  assert.equal(outcomes[0].nextReturnPct, 6)
  assert.equal(outcomes[0].weekReturnPct, 10.89)
  assert.equal(outcomes[0].weekMaxDrawdownPct, -0.99)
  assert.equal(summary.sampleSectors, 5)
  assert.equal(summary.topK, 2)
  assert.equal(summary.topNextHitRatePct, 50)
  assert.ok(summary.topWeekAverageExcessPct > 0)
  assert.ok(summary.ndcgAtK.next > 0)
  assert.ok(summary.ndcgAtK.week > 0)
})

test('未来数据不足时保持null而不是伪装成失败样本', () => {
  const outcomes = labelSectorForecastOutcomes({
    signalDate: '2026-08-20',
    sectors: [{ code: 'BK1', rank: 1 }],
  }, {
    BK1: [{ date: '2026-08-20', close: 100 }],
  })

  assert.equal(outcomes[0].nextReturnPct, null)
  assert.equal(outcomes[0].weekReturnPct, null)
  assert.equal(outcomes[0].nextTopQuintile, null)
  assert.equal(outcomes[0].weekTopQuintile, null)
})
