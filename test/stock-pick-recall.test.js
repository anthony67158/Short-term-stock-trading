import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStockPickRecall } from '../api/_stock_pick_recall.js'
import { handleStockPickRun } from '../api/stock_pick.js'
import { createStockPickStore } from '../api/_stock_pick_store.js'
import { RANKING_SOURCE } from '../shared/stockPick.js'

function poolRow(code, over = {}) {
  return {
    code,
    name: `票${code}`,
    industry: '测试',
    price: 10,
    pct: 4,
    amount: 3e8,
    turnover: 6,
    volumeRatio: 2,
    mainInflow: 1e8,
    mainRatio: 8,
    high: 10.3,
    low: 9.9,
    open: 9.95,
    volume: 1e6,
    tradeDate: '2026-09-17',
    ...over,
  }
}

const fakePool = async () => ({
  total: 5000,
  inspectedCount: 5000,
  allList: [],
  list: [
    poolRow('600000', { mainRatio: 15 }),
    poolRow('600001', { mainRatio: 2 }),
    poolRow('600002', { mainRatio: 9 }),
  ],
})

test('召回：模型分可用时排序来源为 MODEL 且按模型分排序', async () => {
  const snapshot = await buildStockPickRecall({
    now: Date.parse('2026-09-17T02:00:00Z'),
    fetchPool: fakePool,
    fetchMarket: async () => ({}),
    scoreCandidates: async (rows) => rows.map((row) => ({
      code: row.code,
      plans: [{
        opportunityScore: {
          state: 'READY',
          rankingScore: row.code === '600001' ? 0.9 : 0.3,
          modelVersion: 'ranking-model-bundle.v1',
        },
      }],
    })),
  })
  assert.equal(snapshot.availability, 'READY')
  assert.equal(snapshot.rankingSource, RANKING_SOURCE.MODEL)
  assert.equal(snapshot.candidates[0].code, '600001')
  assert.equal(snapshot.modelVersion, 'ranking-model-bundle.v1')
})

test('召回：模型缺失时回落规则召回分并标注 RULE', async () => {
  const snapshot = await buildStockPickRecall({
    now: Date.parse('2026-09-17T02:00:00Z'),
    fetchPool: fakePool,
    fetchMarket: async () => ({}),
    scoreCandidates: async () => { throw new Error('模型未发布') },
  })
  assert.equal(snapshot.availability, 'READY')
  assert.equal(snapshot.rankingSource, RANKING_SOURCE.RULE)
  // 主力净占比最高者规则分最高，排首位。
  assert.equal(snapshot.candidates[0].code, '600000')
  assert.equal(snapshot.candidates[0].model, null)
})

test('召回：全池扫描失败时明确 UNAVAILABLE，不伪装候选', async () => {
  const snapshot = await buildStockPickRecall({
    fetchPool: async () => { throw new Error('全市场快照不完整：4999/5000') },
  })
  assert.equal(snapshot.availability, 'UNAVAILABLE')
  assert.equal(snapshot.reasonCode, 'RECALL_UNIVERSE_INCOMPLETE')
  assert.equal(snapshot.candidates.length, 0)
})

test('handler run：写入最新快照与完成进度，单飞锁阻止并发重复扫描', async () => {
  const store = createStockPickStore({
    hasStorage: () => false,
    put: async () => {},
    readJson: async () => null,
    del: async () => {},
  })
  const recall = async () => ({
    schemaVersion: 'stock-pick.v1',
    availability: 'READY',
    candidates: [{ code: '600000' }],
    universe: { total: 5000, inspected: 5000 },
  })
  const result = await handleStockPickRun({ store, recall })
  assert.equal(result.ok, true)
  assert.equal(result.snapshot.availability, 'READY')
  const latest = await store.readLatest()
  assert.equal(latest.candidates[0].code, '600000')
  const progress = await store.readProgress()
  assert.equal(progress.status, 'DONE')
})
