import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const workflow = read('.github/workflows/daily-retrain.yml')
const settlement = read('api/_learning_settlement.js')
const trainingView = read('api/_learning_training_view.js')

test('每日归档由受保护FC端点压实成熟学习结果', () => {
  assert.match(workflow, /LEARNING_PIPELINE_URL/)
  assert.match(workflow, /LEARNING_CRON_KEY/)
  assert.match(workflow, /x-cron-key: \$LEARNING_CRON_KEY/)
  assert.match(workflow, /--max-time 300/)
  assert.doesNotMatch(workflow, /TUSHARE_TOKEN|QUANT_KEY/)
})

test('训练前先结算成熟结果并发布脱敏视图', () => {
  const settleAt = workflow.indexOf(
    'Settle matured outcomes and publish redacted view',
  )
  const downloadAt = workflow.indexOf(
    'Download latest redacted training view',
  )
  const trainAt = workflow.indexOf('Train and gate challengers')

  assert.ok(settleAt >= 0)
  assert.ok(downloadAt > settleAt)
  assert.ok(trainAt > downloadAt)
  assert.match(settlement, /settleStockPickCandidate/)
  assert.match(settlement, /captureAccountLearningEvents/)
  assert.match(trainingView, /learning-training-view\.v1/)
})

test('Actions只下载learning视图且不读取账户事实目录', () => {
  const trainer = read('qlib-service/learning_pipeline.py')

  assert.match(trainer, /learning\/v1\/manifests\//)
  assert.match(trainer, /learning\/v1\/views\//)
  assert.doesNotMatch(workflow, /accounts\//)
  assert.doesNotMatch(trainer, /accounts\//)
})

test('每日流程不依赖Tushare且不包含生产发布步骤', () => {
  assert.doesNotMatch(workflow, /TUSHARE_TOKEN|archive_tushare/)
  assert.doesNotMatch(
    workflow,
    /activate-baseline|promote_decision_model|upload_decision_model/,
  )
})
