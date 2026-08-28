import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDailyPromptPayload,
} from '../api/daily_report.js'
import {
  buildSectorModelPayload,
} from '../api/_sector_forecast_llm.js'

test('日报模型载荷保留候选交易契约并截断超长软证据', () => {
  const marker = 'UNUSED_DAILY_EVIDENCE'.repeat(400)
  const payload = buildDailyPromptPayload({
    session: 'morning',
    dataBlock: {
      session: '盘前早报',
      day: '2026-08-25',
      asOf: '2026-08-25 08:50',
      aIndices: [{ name: '上证指数', pct: 0.2 }],
      overseas: [],
      commodities: [],
      candidatePools: {
        stocks: Array.from({ length: 20 }, (_, index) => ({
          code: `6000${String(index).padStart(2, '0')}`,
          name: `候选${index}`,
          buyPrice: 10 + index,
          stopPrice: 9 + index,
          targetPrice: 12 + index,
          trigger: marker,
          reason: marker,
        })),
      },
    },
    evidence: {
      items: [{
        id: 'E01',
        category: 'macro',
        categoryLabel: '宏观',
        title: marker,
        summary: marker,
        src: marker,
        publishedAt: '2026-08-25',
        evidenceLevel: 'primary',
      }],
    },
    morningBaseline: {
      day: '2026-08-24',
      report: {
        overview: marker,
        analysis: {
          stockPool: Array.from({ length: 20 }, (_, index) => ({
            code: `0000${String(index).padStart(2, '0')}`,
            name: `旧候选${index}`,
            buyPrice: 8 + index,
          })),
        },
      },
    },
  })

  assert.equal(payload.candidatePools.stocks.length, 12)
  assert.equal(payload.morningBaseline.stockPool.length, 12)
  assert.equal(payload.candidatePools.stocks[0].buyPrice, 10)
  assert.equal(payload.candidatePools.stocks[0].stopPrice, 9)
  assert.equal(payload.candidatePools.stocks[0].targetPrice, 12)
  assert.equal(payload.evidence[0].summary.length, 360)
  assert.equal(payload.evidence[0].title.length, 160)
  assert.equal(payload.morningBaseline.overview.length, 1000)
})

test('板块模型载荷保留排名与资金结构，不携带全部成分股原始对象', () => {
  const marker = 'UNUSED_SECTOR_DETAIL'.repeat(200)
  const payload = buildSectorModelPayload({
    signalDate: '2026-08-25',
    session: 'close',
    sectors: [{
      code: 'BK1000',
      name: '机器人',
      rank: 1,
      phase: 'STARTUP',
      actionability: 'WAIT_PULLBACK',
      factors: {
        flowPersistence: 78,
        verbose: marker,
        nested: { raw: marker },
      },
      penalties: {
        crowding: 8,
        explanation: marker,
      },
      reasons: [marker, '资金连续改善'],
      risks: [marker, '高位分歧'],
      stocks: Array.from({ length: 20 }, (_, index) => ({
        code: `300${String(index).padStart(3, '0')}`,
        name: `成分股${index}`,
        pct: index,
        mainInflow: index * 100,
        mainRatio: index / 10,
        turnover: index + 1,
        entryStage: index === 0 ? 'EARLY_LAYOUT' : 'EXTENDED_WATCH',
        entryLabel: index === 0 ? '潜伏候选' : '已走强，仅跟踪',
        chaseRisk: index !== 0,
        raw: marker,
      })),
    }],
  }, {
    items: [],
  }, Array.from({ length: 12 }, (_, index) => ({
    book: `理论${index}`,
    topic: '资金',
    text: marker,
  })))

  const sector = payload.sectors[0]
  assert.equal(sector.rank, 1)
  assert.equal(sector.factors.flowPersistence, 78)
  assert.equal(sector.factors.nested, undefined)
  assert.equal(sector.stocks.length, 8)
  assert.equal(sector.stocks[0].raw, undefined)
  assert.equal(sector.stocks[0].entryStage, 'EARLY_LAYOUT')
  assert.equal(sector.stocks[1].chaseRisk, true)
  assert.equal(sector.reasons[0].length, 180)
  assert.equal(payload.theories.length, 8)
  assert.equal(payload.theories[0].text.length, 400)
})
