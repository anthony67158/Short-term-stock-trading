import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADVICE_EXECUTION_DIVERGENCE_VERSION,
  summarizeAdviceVsExecution,
} from '../shared/adviceExecutionDivergence.js'

// 构造一条 executionAttribution.v1 归因记录。
function record({
  status = 'COMPLETED',
  filledLots = 1,
  fillRatePct = 100,
  decisionSlippageBps = 5,
  recordDelayMs = 1000,
  plannedExpectedNetR = 0.12,
  realizedNetR = 0.1,
  expectancyErrorR = -0.02,
  validationComplete = true,
} = {}) {
  return {
    schemaVersion: 'execution-attribution.v1',
    status,
    filledLots,
    fillRatePct,
    decisionSlippageBps,
    recordDelayMs,
    plannedExpectedNetR,
    realizedNetR,
    expectancyErrorR,
    validationComplete,
  }
}

test('建议应然线与人工执行线分别汇总', () => {
  const records = [
    record({ plannedExpectedNetR: 0.2, realizedNetR: 0.15, expectancyErrorR: -0.05 }),
    record({ plannedExpectedNetR: 0.1, realizedNetR: 0.12, expectancyErrorR: 0.02 }),
  ]
  const out = summarizeAdviceVsExecution(records)
  assert.equal(out.schemaVersion, ADVICE_EXECUTION_DIVERGENCE_VERSION)
  assert.equal(out.advised.samples, 2)
  assert.equal(out.advised.meanExpectedNetR, 0.15)
  assert.equal(out.executedLine.samples, 2)
  assert.equal(out.executedLine.meanRealizedNetR, 0.135)
  assert.equal(out.divergence.realizedMinusAdvisedR, -0.015)
})

test('漏单计入建议但不进执行线，漏单率反映未严格执行', () => {
  const records = [
    record(),
    record({ status: 'NOT_EXECUTED', filledLots: 0, fillRatePct: 0, realizedNetR: null, validationComplete: false }),
    record({ status: 'NOT_EXECUTED', filledLots: 0, fillRatePct: 0, realizedNetR: null, validationComplete: false }),
  ]
  const out = summarizeAdviceVsExecution(records)
  assert.equal(out.publishedAdvice, 3)
  assert.equal(out.executedCount, 1)
  assert.equal(out.skippedCount, 2)
  assert.equal(out.divergence.skipRatePct, 66.67)
})

test('执行偏差聚合滑价、延迟与期望误差', () => {
  const records = [
    record({ decisionSlippageBps: 4, recordDelayMs: 1000, expectancyErrorR: -0.01 }),
    record({ decisionSlippageBps: 8, recordDelayMs: 3000, expectancyErrorR: -0.03 }),
  ]
  const out = summarizeAdviceVsExecution(records)
  assert.equal(out.divergence.averageDecisionSlippageBps, 6)
  assert.equal(out.divergence.averageRecordDelayMs, 2000)
  assert.equal(out.divergence.meanExpectancyErrorR, -0.02)
})

test('真实完成样本不足20笔时不下执行质量结论', () => {
  const out = summarizeAdviceVsExecution([record()])
  assert.equal(out.executionProvable, false)
  assert.match(out.note, /不足20笔/)
  const many = Array.from({ length: 20 }, () => record())
  assert.equal(summarizeAdviceVsExecution(many).executionProvable, true)
})

test('忽略非法/非本契约记录', () => {
  const out = summarizeAdviceVsExecution([
    null,
    { schemaVersion: 'other' },
    record(),
  ])
  assert.equal(out.publishedAdvice, 1)
})
