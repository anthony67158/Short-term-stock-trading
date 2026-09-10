import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dedupeQuantReports, formatQuantMetric, opportunityReportSnapshot } from '../shared/quantRetrainReport.js'
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
  for (const value of [null, undefined, '', NaN, Infinity, true]) {
    assert.equal(formatQuantMetric(value), '未提供')
  }
})

test('当前V3状态使用真实训练时点且未知样本不补零', () => {
  const snapshot = opportunityReportSnapshot({
    generatedAt: 1788999769800,
    trainingGeneratedAt: 1788999640,
    state: 'REJECTED',
    productionEligible: false,
    readiness: { samples: 73004, filledSamples: 37516, dates: 124 },
    promotionBlockers: ['净R下界未大于0'],
  })
  assert.equal(snapshot.at, 1788999640000)
  assert.equal(snapshot.label, '未通过验证')
  assert.equal(snapshot.samples, 73004)
  assert.equal(snapshot.productionEligible, false)
  assert.equal(opportunityReportSnapshot(null), null)
  assert.equal(opportunityReportSnapshot({ generatedAt: 1788999769800 }).samples, null)
})

test('量化汇报按最新时间读取，并保留同一轮不同模型', async () => {
  const records = [
    { id: 'v3', model: 'opportunity', at: 3, meta: { runId: 12 } },
    { id: 'stock', at: 1, meta: { runId: 12 } },
    { id: 'sector', model: 'sector', at: 2, meta: { runId: 12 } },
  ]
  const output = await listReports(3, {
    list: async ({ limit }) => {
      assert.ok(limit > 500)
      return { blobs: records.map((row) => ({ pathname: row.id, uploadedAt: row.at })) }
    },
    readJson: async (blob) => records.find((row) => row.id === blob.pathname),
  })
  assert.deepEqual(output.map((row) => row.id), ['v3', 'sector', 'stock'])
  assert.equal(await readOpportunitySummary(async () => { throw new Error('offline') }), null)
})

test('V3和板块无论训练成败都发布汇报，晋级上传后才确认发布', () => {
  const workflow = readFileSync('.github/workflows/daily-retrain.yml', 'utf8')
  for (const name of ['V3', 'sector']) {
    const step = workflow.split(`- name: Publish ${name} result to in-app quant report`)[1]?.split('\n      - name:')[0]
    assert.ok(step)
    assert.match(step, /if: always\(\)/)
    assert.match(step, /RETRAIN_JOB_STATUS:/)
    assert.match(step, /publish_model_retrain_report\.py/)
  }
  const publish = workflow.split('- name: Publish production model only after all gates pass')[1].split('\n      - name:')[0]
  assert.ok(publish.indexOf('upload_opportunity_model.py') < publish.indexOf('echo "published=true"'))
  assert.match(workflow, /test_publish_model_retrain_report\.py/)
})
