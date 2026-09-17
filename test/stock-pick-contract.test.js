import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STOCK_PICK_SCHEMA_VERSION,
  RANKING_SOURCE,
  ruleRecallScore,
  normalizeStockPickCandidate,
  rankStockPickCandidates,
  buildStockPickSnapshot,
  unavailableStockPickSnapshot,
} from '../shared/stockPick.js'

test('规则召回分只用公开量价资金事实并给出可解释理由', () => {
  const strong = ruleRecallScore({
    pct: 5, volumeRatio: 2.5, turnover: 8, amount: 6e8,
    mainRatio: 12, price: 11, high: 11.2, low: 10,
  })
  const weak = ruleRecallScore({
    pct: 0.2, volumeRatio: 0.8, turnover: 1, amount: 2e7,
    mainRatio: -3, price: 10.1, high: 11, low: 10,
  })
  assert.ok(strong.score > weak.score)
  assert.ok(strong.score <= 100 && weak.score >= 0)
  assert.ok(strong.reasons.length >= 3)
})

test('候选归一化：模型READY取模型排序分，缺失回落规则分并标注来源', () => {
  const row = {
    code: '600000', name: '浦发银行', industry: '银行',
    price: 10, pct: 3, amount: 3e8, turnover: 5,
    volumeRatio: 1.8, mainInflow: 1e8, mainRatio: 6,
    high: 10.2, low: 9.8, tradeDate: '2026-09-17',
  }
  const withModel = normalizeStockPickCandidate(row, {
    modelScore: {
      state: 'READY', rankingScore: 0.82, pFill: 0.7,
      pWinGivenFill: 0.6, expectedNetR: 0.3, modelVersion: 'ranking-v1',
    },
  })
  assert.equal(withModel.ranking.source, RANKING_SOURCE.MODEL)
  assert.equal(withModel.ranking.score, 0.82)
  assert.equal(withModel.model.modelVersion, 'ranking-v1')

  const ruleOnly = normalizeStockPickCandidate(row, {
    modelScore: { state: 'NOT_READY' },
  })
  assert.equal(ruleOnly.ranking.source, RANKING_SOURCE.RULE)
  assert.equal(ruleOnly.model, null)
  assert.equal(ruleOnly.ranking.score, ruleOnly.recallScore)
})

test('排序：模型候选整体优先于规则候选，组内按分降序', () => {
  const ranked = rankStockPickCandidates([
    { code: 'a', ranking: { source: RANKING_SOURCE.RULE, score: 90 } },
    { code: 'b', ranking: { source: RANKING_SOURCE.MODEL, score: 0.4 } },
    { code: 'c', ranking: { source: RANKING_SOURCE.MODEL, score: 0.7 } },
  ])
  assert.deepEqual(ranked.map((item) => item.code), ['c', 'b', 'a'])
})

test('快照：空候选为 EMPTY，非空为 READY 且截断到上限', () => {
  const empty = buildStockPickSnapshot({ candidates: [], total: 5000 })
  assert.equal(empty.availability, 'EMPTY')
  assert.equal(empty.schemaVersion, STOCK_PICK_SCHEMA_VERSION)

  const many = Array.from({ length: 40 }, (_, index) => ({
    code: String(600000 + index),
    ranking: { source: RANKING_SOURCE.RULE, score: index },
  }))
  const ready = buildStockPickSnapshot({
    candidates: many, total: 5000, inspected: 5000,
  })
  assert.equal(ready.availability, 'READY')
  assert.equal(ready.candidates.length, 24)
  assert.equal(ready.candidates[0].ranking.score, 39)
})

test('不可用快照明确 UNAVAILABLE 且不含候选', () => {
  const snapshot = unavailableStockPickSnapshot({
    reasonCode: 'RECALL_FAILED', reason: '全市场快照不完整',
    tradeDate: '2026-09-17',
  })
  assert.equal(snapshot.availability, 'UNAVAILABLE')
  assert.equal(snapshot.reasonCode, 'RECALL_FAILED')
  assert.equal(snapshot.candidates.length, 0)
})
