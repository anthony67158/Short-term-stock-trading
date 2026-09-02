import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPPORTUNITY_DRIFT_SCHEMA_VERSION,
  detectOpportunityDrift,
} from '../shared/opportunityDriftMonitor.js'

function snapshot(generatedAt, overall) {
  return {
    generatedAt,
    overall: {
      samples: 60,
      completedTrades: 40,
      winRatePct: 55,
      expectedNetRGivenFill: 0.2,
      profitFactor: 1.6,
      sampleSufficient: true,
      ...overall,
    },
  }
}

test('样本不足时只返回监控中状态，绝不产生漂移告警', () => {
  const result = detectOpportunityDrift({
    history: [
      snapshot(1000, { samples: 5, completedTrades: 2, sampleSufficient: false }),
      snapshot(2000, { samples: 8, completedTrades: 3, sampleSufficient: false }),
    ],
  })
  assert.equal(result.schemaVersion, OPPORTUNITY_DRIFT_SCHEMA_VERSION)
  assert.equal(result.state, 'INSUFFICIENT_SAMPLE')
  assert.deepEqual(result.alerts, [])
})

test('历史快照不足两期时无法判断漂移', () => {
  const result = detectOpportunityDrift({
    history: [snapshot(1000, {})],
  })
  assert.equal(result.state, 'INSUFFICIENT_HISTORY')
  assert.deepEqual(result.alerts, [])
})

test('稳定序列不产生噪音告警', () => {
  const result = detectOpportunityDrift({
    history: [
      snapshot(1000, { winRatePct: 54, expectedNetRGivenFill: 0.19 }),
      snapshot(2000, { winRatePct: 55, expectedNetRGivenFill: 0.20 }),
      snapshot(3000, { winRatePct: 56, expectedNetRGivenFill: 0.21 }),
    ],
  })
  assert.equal(result.state, 'STABLE')
  assert.deepEqual(result.alerts, [])
})

test('期望净R显著跌入负区触发漂移告警', () => {
  const result = detectOpportunityDrift({
    history: [
      snapshot(1000, { expectedNetRGivenFill: 0.25, winRatePct: 58 }),
      snapshot(2000, { expectedNetRGivenFill: 0.20, winRatePct: 55 }),
      snapshot(3000, { expectedNetRGivenFill: -0.15, winRatePct: 41 }),
    ],
  })
  assert.equal(result.state, 'DRIFT_DETECTED')
  const netR = result.alerts.find((a) => a.metric === 'expectedNetRGivenFill')
  assert.ok(netR)
  assert.match(netR.message, /净|期望|回报/)
})

test('胜率大幅下滑触发告警', () => {
  const result = detectOpportunityDrift({
    history: [
      snapshot(1000, { winRatePct: 60 }),
      snapshot(2000, { winRatePct: 58 }),
      snapshot(3000, { winRatePct: 38 }),
    ],
    winRateDropPct: 15,
  })
  assert.equal(result.state, 'DRIFT_DETECTED')
  assert.ok(result.alerts.some((a) => a.metric === 'winRatePct'))
})

test('样本覆盖率骤降触发覆盖率告警', () => {
  const result = detectOpportunityDrift({
    history: [
      snapshot(1000, { samples: 80 }),
      snapshot(2000, { samples: 75 }),
      snapshot(3000, { samples: 20 }),
    ],
    coverageDropRatio: 0.5,
  })
  assert.ok(result.alerts.some((a) => a.metric === 'coverage'))
})

test('连续亏损窗口达到阈值触发告警', () => {
  const result = detectOpportunityDrift({
    history: [
      snapshot(1000, { expectedNetRGivenFill: -0.05 }),
      snapshot(2000, { expectedNetRGivenFill: -0.08 }),
      snapshot(3000, { expectedNetRGivenFill: -0.12 }),
    ],
    lossStreakWindows: 3,
  })
  assert.ok(result.alerts.some((a) => a.metric === 'lossStreak'))
})

test('空输入安全降级', () => {
  const result = detectOpportunityDrift({ history: [] })
  assert.equal(result.state, 'INSUFFICIENT_HISTORY')
  assert.deepEqual(result.alerts, [])
})
