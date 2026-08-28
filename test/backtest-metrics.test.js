import test from 'node:test'
import assert from 'node:assert/strict'

import { computeBacktestMetrics } from '../shared/backtest/metrics.js'

test('无交易时返回不可评估且不判正期望', () => {
  const metrics = computeBacktestMetrics([])
  assert.equal(metrics.trades, 0)
  assert.equal(metrics.profitable, false)
})

test('正期望组合被判定具备统计优势', () => {
  // 3胜2负，平均盈利大于平均亏损，期望为正
  const trades = [
    { netPnl: 300, returnPct: 3, holdingDays: 2 },
    { netPnl: 250, returnPct: 2.5, holdingDays: 1 },
    { netPnl: 200, returnPct: 2, holdingDays: 3 },
    { netPnl: -120, returnPct: -1.2, holdingDays: 2 },
    { netPnl: -100, returnPct: -1, holdingDays: 1 },
  ]
  const metrics = computeBacktestMetrics(trades, { label: '回踩低吸-样本外' })

  assert.equal(metrics.trades, 5)
  assert.equal(metrics.wins, 3)
  assert.equal(metrics.losses, 2)
  assert.equal(metrics.winRatePct, 60)
  assert.ok(metrics.expectancyCash > 0)
  assert.equal(metrics.expectancyPositive, true)
  assert.ok(metrics.payoffRatio > 1)
  assert.ok(metrics.profitFactor > 1)
  assert.equal(metrics.label, '回踩低吸-样本外')
  assert.match(metrics.verdict, /具备正统计优势/)
})

test('高胜率但被大亏损吃掉时判为负期望禁止实盘', () => {
  // 4次小赚、1次巨亏，胜率80%但期望为负 —— 这正是要拦截的假优势
  const trades = [
    { netPnl: 50, returnPct: 0.5 },
    { netPnl: 50, returnPct: 0.5 },
    { netPnl: 50, returnPct: 0.5 },
    { netPnl: 50, returnPct: 0.5 },
    { netPnl: -800, returnPct: -8 },
  ]
  const metrics = computeBacktestMetrics(trades)

  assert.equal(metrics.winRatePct, 80)
  assert.ok(metrics.expectancyCash < 0)
  assert.equal(metrics.expectancyPositive, false)
  assert.ok(metrics.profitFactor < 1)
  assert.match(metrics.verdict, /禁止接入实盘/)
})

test('现金期望为正但收益率期望为负时禁止放行（大仓位单笔带偏）', () => {
  // 一笔大仓位小幅盈利(现金+)，多笔小仓位亏损(收益率均值-)：
  // 汇总现金可能为正，但每笔收益率期望为负，必须判为不具备优势。
  const trades = [
    { netPnl: 500, returnPct: 0.5 },   // 大仓位、低收益率
    { netPnl: -60, returnPct: -2 },
    { netPnl: -60, returnPct: -2 },
    { netPnl: -60, returnPct: -2 },
  ]
  const metrics = computeBacktestMetrics(trades)
  assert.ok(metrics.expectancyCash > 0, '现金期望为正')
  assert.ok(metrics.expectancyPct < 0, '收益率期望为负')
  assert.equal(metrics.expectancyPositive, false, '应以收益率期望为准，禁止放行')
  assert.match(metrics.verdict, /禁止接入实盘/)
})

test('最大回撤按累计净值序列计算', () => {
  const trades = [
    { netPnl: 100, returnPct: 10 },
    { netPnl: -50, returnPct: -20 },
    { netPnl: 30, returnPct: 5 },
  ]
  const metrics = computeBacktestMetrics(trades)
  // 第一笔+10%→1.1，第二笔-20%→0.88，回撤(1.1-0.88)/1.1≈20%
  assert.ok(metrics.maxDrawdownPct >= 19 && metrics.maxDrawdownPct <= 21)
})
