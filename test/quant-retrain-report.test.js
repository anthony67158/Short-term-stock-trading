import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  dedupeQuantReports,
  normalizeRetrainRun,
} from '../shared/quantRetrainReport.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('GitHub每日重训运行态归一化为稳定公开契约', () => {
  const running = normalizeRetrainRun({
    id: 31961972386,
    run_number: 11,
    status: 'in_progress',
    conclusion: null,
    event: 'schedule',
    run_started_at: '2026-08-16T17:33:44Z',
    updated_at: '2026-08-16T17:40:00Z',
    html_url: 'https://github.com/example/repo/actions/runs/31961972386',
    head_sha: '065a73415b94283bed31ea55b643c8705eb34ae1',
  }, Date.parse('2026-08-16T17:40:00Z'))

  assert.deepEqual(running, {
    runId: 31961972386,
    runNumber: 11,
    state: 'running',
    status: 'in_progress',
    conclusion: null,
    event: 'schedule',
    startedAt: Date.parse('2026-08-16T17:33:44Z'),
    completedAt: null,
    updatedAt: Date.parse('2026-08-16T17:40:00Z'),
    durationSec: 376,
    url: 'https://github.com/example/repo/actions/runs/31961972386',
    headSha: '065a73415b94',
  })

  const success = normalizeRetrainRun({
    ...running,
    id: 31961972386,
    run_number: 11,
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-08-16T17:33:44Z',
    updated_at: '2026-08-16T17:53:14Z',
  })
  assert.equal(success.state, 'success')
  assert.equal(success.durationSec, 1170)
})

test('量化汇报按runId幂等去重，旧记录按内容去重', () => {
  const reports = dedupeQuantReports([
    { id: 'new', at: 30, body: 'B', meta: { runId: 11 } },
    { id: 'retry', at: 20, body: 'A', meta: { runId: 11 } },
    { id: 'legacy-new', at: 15, decision: 'reject', body: 'same' },
    { id: 'legacy-old', at: 10, decision: 'reject', body: 'same' },
  ])

  assert.deepEqual(reports.map((item) => item.id), ['new', 'legacy-new'])
})

test('每日重训工作流把结果按run_id写入量化汇报OSS', () => {
  const workflow = read('.github/workflows/daily-retrain.yml')
  const publisher = read('qlib-service/publish_retrain_report.py')

  assert.match(workflow, /Publish result to in-app quant report/)
  assert.match(workflow, /python publish_retrain_report\.py/)
  assert.match(workflow, /Verify incremental training and forecast contracts/)
  assert.match(workflow, /test_retrain_daily\.py/)
  assert.match(workflow, /test_build_dataset_forecast\.py/)
  assert.match(workflow, /test_production_backtest\.py/)
  assert.match(workflow, /test_app_forecast\.py/)
  assert.match(workflow, /test_publish_retrain_report\.py/)
  assert.match(workflow, /GITHUB_RUN_ID:/)
  assert.match(workflow, /OSS_ACCESS_KEY_ID:\s*\$\{\{\s*secrets\.OSS_ACCESS_KEY_ID\s*\}\}/)
  assert.match(publisher, /quantreport\/retrain-\{run_id\}\.json/)
  assert.match(publisher, /增量适配样本/)
  assert.match(publisher, /独立盲测样本/)
  assert.match(publisher, /Top10% 精度/)
  assert.match(publisher, /put_object\(/)
  assert.doesNotMatch(workflow, /QUANT_REPORT_KEY/)
})

test('量化汇报弹窗展示任务状态、训练结果和GitHub运行入口', () => {
  const api = read('api/quant_report.js')
  const component = read('src/components/QuantReport.jsx')
  const store = read('src/quantReportStore.js')

  assert.match(api, /normalizeRetrainRun/)
  assert.match(api, /api\.github\.com\/repos\/anthony67158\/Short-term-stock-trading\/actions\/workflows\/daily-retrain\.yml\/runs/)
  assert.match(api, /workflow/)
  assert.match(store, /workflow:/)
  assert.match(component, /每日重训任务/)
  assert.match(component, /训练中/)
  assert.match(component, /运行详情/)
  assert.match(component, /r\.meta\?\.runNumber/)
})
