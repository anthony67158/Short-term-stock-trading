import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateTailPickIntraday,
  evaluateTailPickMarketGate,
  evaluateTailPickStockGate,
  tailPickSession,
} from '../shared/tailPickPolicy.js'

function beijingTimestamp(text) {
  return new Date(`${text}+08:00`).getTime()
}

function indexCandles() {
  return Array.from({ length: 60 }, (_, index) => ({
    close: 10 + index * 0.02,
    volume: 1000 + index,
  }))
}

function strongMarket() {
  return {
    updatedAt: beijingTimestamp('2026-08-28T14:50:00'),
    indices: [
      { code: '000001', name: '上证指数', pct: 0.8 },
      { code: '399001', name: '深证成指', pct: 1.1 },
    ],
    breadth: {
      up: 3600,
      down: 1300,
      flat: 100,
      limitUp: 58,
      limitDown: 5,
      volumeComparable: true,
      volLevel: '放量',
      volVsAvg5: 12,
    },
    sentiment: {
      phase: 'EXPANSION',
      phaseLabel: '发酵',
      breakRatePct: 15,
      maxBoardHeight: 5,
      hardRiskSignals: [],
    },
  }
}

test('14:50自动正式扫描且其它时间保留手动试算', () => {
  const before = tailPickSession(
    beijingTimestamp('2026-08-28T14:49:00'),
  )
  assert.equal(before.status, 'BEFORE_WINDOW')
  assert.equal(before.canRun, true)
  assert.equal(before.formalRunDue, false)

  assert.equal(
    tailPickSession(
      beijingTimestamp('2026-08-28T14:50:00'),
    ).formalRunDue,
    true,
  )
  const after = tailPickSession(
    beijingTimestamp('2026-08-28T14:55:00'),
  )
  assert.equal(after.status, 'LOCKED')
  assert.equal(after.canRun, true)
  assert.match(after.reason, /手动运行仅用于复盘/)

  const rest = tailPickSession(
    beijingTimestamp('2026-08-29T14:50:00'),
  )
  assert.equal(rest.status, 'REST')
  assert.equal(rest.canRun, true)
})

test('大盘与主线方向同时通过才允许继续扫描', () => {
  const result = evaluateTailPickMarketGate({
    market: strongMarket(),
    indexSeries: [
      { code: '000001', name: '上证指数', candles: indexCandles() },
      { code: '399001', name: '深证成指', candles: indexCandles() },
    ],
    sectorSnapshot: {
      sectors: [{
        actionability: 'LAYOUT',
        forecast: { next: { score: 68 } },
      }],
    },
  })

  assert.equal(result.allowed, true)
  assert.equal(result.label, '允许公式观察')
})

test('大盘数据缺失或没有主线时直接输出今日不开仓', () => {
  const result = evaluateTailPickMarketGate({
    market: {},
    indexSeries: [],
    sectorSnapshot: { sectors: [] },
  })

  assert.equal(result.allowed, false)
  assert.equal(result.label, '今日不开仓')
  assert.match(result.blockers.join('；'), /数据不完整/)
  assert.match(result.blockers.join('；'), /主线方向/)
})

test('最近5分钟持续站稳均价线且无放量跳水才通过分时纪律', () => {
  const trends = Array.from({ length: 10 }, (_, index) => ({
    time: `14:${String(41 + index).padStart(2, '0')}`,
    price: 10 + index * 0.01,
    avg: 9.98 + index * 0.005,
    volume: 100,
  }))
  const passed = evaluateTailPickIntraday(trends)
  assert.equal(passed.passed, true)

  const broken = trends.map((item) => ({ ...item }))
  broken.at(-1).price = 9.8
  broken.at(-1).volume = 1000
  const failed = evaluateTailPickIntraday(broken)
  assert.equal(failed.passed, false)
  assert.match(failed.blockers.join('；'), /均价线|放量跳水/)
})

test('高位、低流动性或弱板块不能进入最终候选', () => {
  const candles = Array.from({ length: 31 }, (_, index) => ({
    close: index === 10 ? 10 : 14,
  }))
  const result = evaluateTailPickStockGate({
    code: '600001',
    name: '测试股份',
    candles,
    quote: { price: 14, amount: 40_000_000 },
    sectorOpportunity: { matched: false },
    intraday: { passed: true, evidence: [] },
  })

  assert.equal(result.passed, false)
  assert.match(result.blockers.join('；'), /成交额低于5000万元/)
  assert.match(result.blockers.join('；'), /近20日已上涨/)
  assert.match(result.blockers.join('；'), /主线方向/)
})
