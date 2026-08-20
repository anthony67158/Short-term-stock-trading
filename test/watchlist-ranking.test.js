import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

test('自选排序按立即买入回调再买试错无建议观望分层', () => {
  const candidates = [
    { code: '600001', qScore: 30, targetPrice: 10 },
    { code: '600002', qScore: 95, targetPrice: 10 },
    { code: '600003', qScore: 99, targetPrice: 10, star: true },
    { code: '600004', qScore: 80, targetPrice: 10 },
    { code: '600005', qScore: 90, targetPrice: 10 },
  ]
  const quotes = Object.fromEntries(
    candidates.map((item) => [item.code, { price: 10 }]),
  )
  const advice = {
    '600001': {
      mode: 'buy_advice',
      advice: { action: '立即买入', tier: 'now' },
    },
    '600002': {
      mode: 'buy_advice',
      advice: { action: '回调再买', tier: 'pullback' },
    },
    '600003': {
      mode: 'buy_advice',
      advice: { action: '观望', tier: 'wait' },
    },
    '600005': {
      mode: 'buy_advice',
      advice: { action: '小仓试错', tier: 'probe' },
    },
  }

  const ranked = rankWatchlistCandidates(
    candidates,
    quotes,
    advice,
  )

  assert.deepEqual(
    ranked.map((item) => item.code),
    ['600001', '600002', '600005', '600004', '600003'],
  )
  assert.deepEqual(
    ranked.map((item) => item.advicePriority.label),
    ['立即买入', '回调再买', '小仓试错', '尚无建议', '观望'],
  )
})

test('同一建议档位内仍按重点关注和原买入准备度排序', () => {
  const candidates = [
    { code: '600001', qScore: 80, targetPrice: 10 },
    { code: '600002', qScore: 40, targetPrice: 10, star: true },
    { code: '600003', qScore: 65, targetPrice: 10 },
  ]
  const quotes = {
    '600001': { price: 10.5 },
    '600002': { price: 10.8 },
    '600003': { price: 10.01 },
  }
  const advice = Object.fromEntries(
    candidates.map((item) => [item.code, {
      mode: 'buy_advice',
      advice: { action: '回调再买', tier: 'pullback' },
    }]),
  )

  const ranked = rankWatchlistCandidates(
    candidates,
    quotes,
    advice,
  )

  assert.deepEqual(
    ranked.map((item) => item.code),
    ['600002', '600003', '600001'],
  )
})

test('自选列表订阅建议更新并把建议映射传入排序器', () => {
  const source = readFileSync(
    new URL('../src/components/PlanTab.jsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /const \[adviceVersion,\s*setAdviceVersion\]/)
  assert.match(source, /const adviceByCode =/)
  assert.match(
    source,
    /rankWatchlistCandidates\([\s\S]*?quote,[\s\S]*?adviceByCode/,
  )
  assert.match(source, /按建议档位与买入准备度排序/)
})
