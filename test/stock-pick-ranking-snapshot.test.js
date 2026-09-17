import test from 'node:test'
import assert from 'node:assert/strict'

import {
  rankingScoreLookup,
} from '../api/_ranking_score_snapshot.js'
import { buildStockPickRecall } from '../api/_stock_pick_recall.js'
import { RANKING_SOURCE } from '../shared/stockPick.js'

const snapshot = {
  schemaVersion: 'ranking-score-snapshot.v1',
  bundleId: 'ashare-rank-lgbm-v1',
  modelVersion: 'ashare-rank-lgbm-v1',
  decisionDate: '20241224',
  scores: {
    '600000': { rankScore: 0.16, rankPercentile: 0.98, expectedGrossReturn: 0.03 },
    '600001': { rankScore: -0.07, rankPercentile: 0.12, expectedGrossReturn: -0.01 },
  },
}

test('rankingScoreLookup 命中返回 READY 模型分，未命中返回 null', () => {
  const lookup = rankingScoreLookup(snapshot)
  const hit = lookup('600000')
  assert.equal(hit.state, 'READY')
  assert.equal(hit.rankingScore, 0.98)
  assert.equal(hit.modelVersion, 'ashare-rank-lgbm-v1')
  assert.equal(lookup('999999'), null)
})

test('召回层接入排序快照后，命中候选排序来源为 MODEL', async () => {
  const poolRow = (code, mainRatio) => ({
    code, name: `票${code}`, industry: '测试',
    price: 10, pct: 4, amount: 3e8, turnover: 6,
    volumeRatio: 2, mainInflow: 1e8, mainRatio,
    high: 10.3, low: 9.9, tradeDate: '2026-09-17',
  })
  const result = await buildStockPickRecall({
    now: Date.parse('2026-09-17T02:00:00Z'),
    fetchPool: async () => ({
      total: 5000, inspectedCount: 5000, allList: [],
      list: [poolRow('600000', 5), poolRow('600001', 3)],
    }),
    fetchMarket: async () => ({}),
    // 决策模型不应被调用（排序快照优先命中）
    scoreCandidates: async () => { throw new Error('不应回落决策模型') },
    loadRankingSnapshot: async () => snapshot,
  })
  assert.equal(result.availability, 'READY')
  assert.equal(result.rankingSource, RANKING_SOURCE.MODEL)
  assert.equal(result.modelVersion, 'ashare-rank-lgbm-v1')
  // 600000 模型分(0.98) 高于 600001(0.12)，排首位
  assert.equal(result.candidates[0].code, '600000')
})
