import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ALPHA158_RUNTIME_SNAPSHOT_VERSION,
  ALPHA158_SIGNAL_FEATURE_NAMES,
  alpha158SignalFromSnapshot,
  alpha158FeatureBlock,
  neutralAlpha158FeatureBlock,
  normalizeAlpha158RuntimeSnapshot,
} from '../shared/alpha158SignalFeatures.js'

const EXPECTED_DATE = '20260911'

function activeSignal(overrides = {}) {
  return {
    state: 'ACTIVE',
    asOfDate: '20260911',
    percentile: 0.9,
    recentRankIc: 0.05,
    overallRankIc: 0.03,
    scoreMomentum5: 0.2,
    ...overrides,
  }
}

test('特征块顺序与契约固定一致且为定长向量', () => {
  const block = neutralAlpha158FeatureBlock()
  assert.deepEqual(block.names, ALPHA158_SIGNAL_FEATURE_NAMES)
  assert.equal(block.vector.length, ALPHA158_SIGNAL_FEATURE_NAMES.length)
})

test('缺失信号全部退化为0中性并置Missing掩码', () => {
  const block = alpha158FeatureBlock(null, { expectedDate: EXPECTED_DATE })
  assert.equal(block.available, false)
  assert.equal(block.values.alphaScoreZ, 0)
  assert.equal(block.values.alphaScorePctRank, 0)
  assert.equal(block.values.alphaScoreZMissing, 1)
  assert.equal(block.values.alphaRankIcMissing, 1)
  assert.equal(block.values.alphaScoreMomentumMissing, 1)
})

test('有效信号编码分位、居中z、RankIC与动量', () => {
  const block = alpha158FeatureBlock(activeSignal(), {
    expectedDate: EXPECTED_DATE,
  })
  assert.equal(block.available, true)
  assert.equal(block.values.alphaScorePctRank, 0.9)
  assert.equal(block.values.alphaScoreZ, 0.8) // (0.9-0.5)*2
  assert.equal(block.values.alphaScoreZMissing, 0)
  assert.equal(block.values.alphaRankIc20, 0.05)
  assert.equal(block.values.alphaRankIc60, 0.03)
  assert.equal(block.values.alphaRankIcMissing, 0)
  assert.equal(block.values.alphaScoreMomentum5, 0.2)
})

test('过期快照退化为中性', () => {
  const stale = activeSignal({ asOfDate: '20260101' })
  const block = alpha158FeatureBlock(stale, { expectedDate: EXPECTED_DATE })
  assert.equal(block.available, false)
  assert.equal(block.values.alphaScoreZMissing, 1)
})

test('未来快照(asOf晚于决策日)也判为不可用', () => {
  const future = activeSignal({ asOfDate: '20261231' })
  const block = alpha158FeatureBlock(future, { expectedDate: EXPECTED_DATE })
  assert.equal(block.available, false)
})

test('非ACTIVE状态不采用', () => {
  const research = activeSignal({ state: 'RESEARCH' })
  const block = alpha158FeatureBlock(research, { expectedDate: EXPECTED_DATE })
  assert.equal(block.available, false)
})

test('极端值被夹到[-1,1]与[0,1]', () => {
  const extreme = activeSignal({
    percentile: 1.2,       // 非法分位 → 缺失
    recentRankIc: 5,
    overallRankIc: -5,
    scoreMomentum5: 9,
  })
  const block = alpha158FeatureBlock(extreme, { expectedDate: EXPECTED_DATE })
  assert.equal(block.values.alphaScoreZMissing, 1) // 分位非法
  assert.equal(block.values.alphaRankIc20, 1)
  assert.equal(block.values.alphaRankIc60, -1)
  assert.equal(block.values.alphaScoreMomentum5, 1)
})

test('生产排名快照只转换为连续特征信号，不产生联合排序', () => {
  const snapshot = normalizeAlpha158RuntimeSnapshot({
    schemaVersion: ALPHA158_RUNTIME_SNAPSHOT_VERSION,
    state: 'ACTIVE',
    productionEligible: true,
    asOfDate: '20260911',
    modelVersion: 'alpha158.test',
    metrics: {
      recentRankIc: 0.05,
      overallRankIc: 0.03,
    },
    stocks: {
      600001: { percentile: 0.9, scoreMomentum5: 0.2 },
      300001: { percentile: 0.8 },
    },
  })
  const signal = alpha158SignalFromSnapshot(snapshot, '600001')

  assert.equal(snapshot.stocks.size, 1)
  assert.equal(signal.state, 'ACTIVE')
  assert.equal(signal.percentile, 0.9)
  assert.equal(signal.recentRankIc, 0.05)
  assert.equal(signal.overallRankIc, 0.03)
  assert.equal(signal.scoreMomentum5, 0.2)
})
