import test from 'node:test'
import assert from 'node:assert/strict'

import {
  rankWatchlistCandidates,
  watchlistReadiness,
} from '../shared/watchlistRanking.js'

test('临近买入价的中高分股票排在量化更高但远离买点的股票前面', () => {
  const candidates = [
    { code: '600001', qScore: 82, targetPrice: 10, addedAt: 1 },
    { code: '600002', qScore: 68, targetPrice: 10, addedAt: 2 },
  ]
  const quotes = {
    '600001': { price: 10.75, pct: 2 },
    '600002': { price: 10.02, pct: 1 },
  }

  const ranked = rankWatchlistCandidates(candidates, quotes)

  assert.deepEqual(ranked.map((item) => item.code), ['600002', '600001'])
  assert.ok(ranked[0].readiness.score > ranked[1].readiness.score)
})

test('买点距离相同时量化分更高的股票优先', () => {
  const candidates = [
    { code: '600001', qScore: 70, targetPrice: 10 },
    { code: '600002', qScore: 55, targetPrice: 10 },
  ]
  const quotes = {
    '600001': { price: 10.1 },
    '600002': { price: 10.1 },
  }

  const ranked = rankWatchlistCandidates(candidates, quotes)

  assert.deepEqual(ranked.map((item) => item.code), ['600001', '600002'])
})

test('明显跌穿买入价不会被误判为最高买入准备度', () => {
  const near = watchlistReadiness(
    { code: '600001', qScore: 65, targetPrice: 10 },
    { price: 10 },
  )
  const broken = watchlistReadiness(
    { code: '600002', qScore: 65, targetPrice: 10 },
    { price: 9.2 },
  )

  assert.equal(near.status, 'reached')
  assert.equal(broken.status, 'broken')
  assert.ok(near.score > broken.score)
})

test('重点关注仍置顶且缺少买入价时不会获得虚假接近度', () => {
  const candidates = [
    { code: '600001', qScore: 90 },
    { code: '600002', qScore: 30, star: true },
  ]
  const quotes = {
    '600001': { price: 10 },
    '600002': { price: 10 },
  }

  const ranked = rankWatchlistCandidates(candidates, quotes)

  assert.deepEqual(ranked.map((item) => item.code), ['600002', '600001'])
  assert.equal(ranked[0].readiness.proximityScore, null)
})
