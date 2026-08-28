import test from 'node:test'
import assert from 'node:assert/strict'

import {
  behaviorGuardrails,
  realPerformanceMirror,
} from '../shared/tradingDiscipline.js'

const DAY = 24 * 60 * 60 * 1000
// 用一个明显在"北京日内"的基准时间，避免跨零点抖动。
const NOW = Date.parse('2026-08-28T06:00:00.000Z') // 北京 14:00

function exit(overrides = {}) {
  return {
    type: 'CLOSE',
    at: NOW,
    realizedPnl: 100,
    buyFee: 5,
    sellFee: 5,
    ...overrides,
  }
}

test('真实业绩镜子：样本不足时不下胜率结论', () => {
  const mirror = realPerformanceMirror([exit(), exit()], { minimumSamples: 5 })
  assert.equal(mirror.qualified, false)
  assert.match(mirror.verdict, /样本还太少/)
})

test('真实业绩镜子：扣费后为负要明确点破亏损', () => {
  const closed = [
    exit({ realizedPnl: -300 }),
    exit({ realizedPnl: -200 }),
    exit({ realizedPnl: 50 }),
    exit({ realizedPnl: -80 }),
    exit({ realizedPnl: 30 }),
  ]
  const mirror = realPerformanceMirror(closed)
  assert.equal(mirror.qualified, true)
  assert.ok(mirror.netPnl < 0)
  assert.equal(mirror.samples, 5)
  assert.equal(mirror.wins, 2)
  assert.equal(mirror.losses, 3)
  assert.match(mirror.verdict, /亏的|收紧/)
})

test('真实业绩镜子：手续费拖累与盈亏比可计算', () => {
  const closed = [
    exit({ realizedPnl: 200, buyFee: 10, sellFee: 10 }),
    exit({ realizedPnl: 100, buyFee: 10, sellFee: 10 }),
    exit({ realizedPnl: -100, buyFee: 10, sellFee: 10 }),
    exit({ realizedPnl: 150, buyFee: 10, sellFee: 10 }),
    exit({ realizedPnl: -50, buyFee: 10, sellFee: 10 }),
  ]
  const mirror = realPerformanceMirror(closed)
  assert.equal(mirror.totalFees, 100) // 5 笔 × 20
  assert.equal(mirror.profitFactor, 3) // 毛利450 / 毛损150
  assert.ok(mirror.feeDragPct != null && mirror.feeDragPct > 0)
})

test('真实业绩镜子：只认已实现出场，忽略纯买入', () => {
  const closed = [
    exit(),
    { type: 'BUY', at: NOW, realizedPnl: null },
    { type: 'CLOSE', at: NOW, realizedPnl: null }, // 无盈亏不计
  ]
  const mirror = realPerformanceMirror(closed, { minimumSamples: 1 })
  assert.equal(mirror.samples, 1)
})

test('行为护栏：今日连亏达阈值触发冷静期', () => {
  const closed = [
    exit({ realizedPnl: -100, at: NOW - 3 * 60000 }),
    exit({ realizedPnl: -80, at: NOW - 2 * 60000 }),
    exit({ realizedPnl: -50, at: NOW - 1 * 60000 }),
  ]
  const guard = behaviorGuardrails({ closed, now: NOW, lossStreakCooldown: 3 })
  assert.equal(guard.dailyLossStreak, 3)
  const cooldown = guard.alerts.find((a) => a.code === 'LOSS_STREAK_COOLDOWN')
  assert.ok(cooldown)
  assert.equal(cooldown.level, 'danger')
  assert.match(cooldown.message, /连续亏损 3 笔/)
})

test('行为护栏：交易过频触发高频预警', () => {
  const closed = Array.from({ length: 6 }, (_, i) =>
    exit({ realizedPnl: i % 2 ? 20 : -20, at: NOW - i * 60000 }),
  )
  const guard = behaviorGuardrails({ closed, now: NOW, maxTradesPerDay: 6 })
  assert.equal(guard.todayTrades, 6)
  assert.ok(guard.alerts.some((a) => a.code === 'OVER_TRADING'))
})

test('行为护栏：昨日的连亏不算进今日冷静期', () => {
  const closed = [
    exit({ realizedPnl: -100, at: NOW - DAY - 3 * 60000 }),
    exit({ realizedPnl: -80, at: NOW - DAY - 2 * 60000 }),
    exit({ realizedPnl: -50, at: NOW - DAY - 1 * 60000 }),
  ]
  const guard = behaviorGuardrails({ closed, now: NOW, lossStreakCooldown: 3 })
  assert.equal(guard.dailyLossStreak, 0)
  // 跨日连亏仍应给出较轻的"最近连亏"提醒
  assert.ok(guard.alerts.some((a) => a.code === 'LOSS_STREAK'))
})

test('行为护栏：无异常时不产生噪音告警', () => {
  const closed = [
    exit({ realizedPnl: 120, at: NOW }),
    exit({ realizedPnl: -40, at: NOW - 60000 }),
  ]
  const guard = behaviorGuardrails({ closed, now: NOW })
  assert.equal(guard.alerts.length, 0)
})
