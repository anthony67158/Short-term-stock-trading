import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decisionWorkflowRun,
  dedupeQuantReports,
  formatQuantMetric,
  opportunityReportSnapshot,
} from '../shared/quantRetrainReport.js'
import { listReports, readOpportunitySummary } from '../api/quant_report.js'

test('同一轮三个模型分别保留，单模型重试覆盖旧汇报', () => {
  const result = dedupeQuantReports([
    { id: 'stock', at: 1, meta: { runId: 12 } },
    { id: 'v3-old', at: 2, model: 'opportunity', meta: { runId: 12 } },
    { id: 'sector', at: 3, model: 'sector', meta: { runId: 12 } },
    { id: 'v3', at: 4, model: 'opportunity', meta: { runId: 12 } },
  ])
  assert.deepEqual(result.map((row) => row.id), ['v3', 'sector', 'stock'])
})

test('量化指标保留负值和零值，缺失值不冒充零', () => {
  assert.equal(formatQuantMetric(-0.518984, 'r'), '-0.519 R')
  assert.equal(formatQuantMetric(0, 'percent'), '0.00%')
  assert.equal(formatQuantMetric(8.125, 'ms'), '8.13 ms')
  for (const value of [null, undefined, '', NaN, Infinity, true]) {
    assert.equal(formatQuantMetric(value), '未提供')
  }
})

test('当前决策模型状态使用真实训练时点且未知样本不补零', () => {
  const snapshot = opportunityReportSnapshot({
    generatedAt: 1788999769800,
    trainingGeneratedAt: 1788999640,
    state: 'REJECTED',
    productionEligible: false,
    activeModel: {
      modelVersion: 'opportunity-score.production',
      usagePolicy: 'DIRECT',
    },
    lastReleaseDecision: {
      action: 'KEEP_CURRENT',
      reason: '本轮没有组成部分通过',
      releaseMode: 'NONE',
      promotedComponents: [],
    },
    readiness: { samples: 73004, filledSamples: 37516, dates: 124 },
    promotionBlockers: ['净R下界未大于0'],
  })
  assert.equal(snapshot.at, 1788999640000)
  assert.equal(snapshot.label, '未通过验证')
  assert.equal(snapshot.samples, 73004)
  assert.equal(snapshot.productionEligible, false)
  assert.equal(snapshot.modelVersion, 'opportunity-score.production')
  assert.equal(snapshot.lastReleaseDecision.action, 'KEEP_CURRENT')
  assert.equal(opportunityReportSnapshot(null), null)
  assert.equal(opportunityReportSnapshot({ generatedAt: 1788999769800 }).samples, null)
})

test('量化汇报按最新时间读取，并保留同一轮不同模型', async () => {
  const records = [
    { id: 'v3', model: 'opportunity', at: 3, meta: { runId: 12 } },
    { id: 'stock', at: 1, meta: { runId: 12 } },
    { id: 'sector', model: 'sector', at: 2, meta: { runId: 12 } },
  ]
  const storage = {
    list: async ({ limit }) => {
      assert.ok(limit > 500)
      return { blobs: records.map((row) => ({ pathname: row.id, uploadedAt: row.at })) }
    },
    readJson: async (blob) => records.find((row) => row.id === blob.pathname),
  }
  const output = await listReports(3, storage)
  assert.deepEqual(output.map((row) => row.id), ['v3', 'sector', 'stock'])
  const v3Only = await listReports(3, storage, 'opportunity')
  assert.deepEqual(v3Only.map((row) => row.id), ['v3'])
  assert.equal(await readOpportunitySummary(async () => { throw new Error('offline') }), null)
})

test('每日训练无论门禁结果都保留诊断报告且不直接发布', () => {
  const workflow = readFileSync('.github/workflows/daily-retrain.yml', 'utf8')
  assert.match(workflow, /Upload diagnostics/)
  assert.match(workflow, /if: always\(\)/)
  assert.match(workflow, /learning-artifacts\/run\/report\.json/)
  assert.match(workflow, /Upload immutable challenger run/)
  assert.doesNotMatch(
    workflow,
    /Publish selected decision release atomically|upload_decision_model/,
  )
})

test('量化汇报用决策任务结果覆盖整条工作流的辅助任务失败', () => {
  const run = decisionWorkflowRun({
    current: null,
    latest: {
      runId: 34521836061,
      runNumber: 36,
      state: 'failed',
      status: 'completed',
      conclusion: 'failure',
    },
  }, [{
    model: 'opportunity',
    meta: {
      runId: 34521836061,
      workflowStatus: 'success',
    },
  }])

  assert.equal(run.state, 'success')
  assert.equal(run.conclusion, 'success')
  assert.equal(run.scope, 'opportunity-retrain')
})

test('决策任务已完成时不被仍在运行的辅助任务误报为训练中', () => {
  const run = decisionWorkflowRun({
    current: {
      runId: 42,
      runNumber: 37,
      state: 'running',
      status: 'in_progress',
      conclusion: null,
    },
  }, [{
    model: 'opportunity',
    meta: { runId: 42, workflowStatus: 'success' },
  }])

  assert.equal(run.state, 'success')
  assert.equal(run.scope, 'opportunity-retrain')
})
