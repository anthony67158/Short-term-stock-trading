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

test('每日归档由FC定时器先于Actions压实成熟学习结果', () => {
  const schedule = read('s.yaml')
  assert.match(schedule, /triggerName: learning-settlement-timer/)
  assert.match(
    schedule,
    /cronExpression: "CRON_TZ=Asia\/Shanghai 0 20 17 \* \* 1-5"/,
  )
  assert.doesNotMatch(workflow, /LEARNING_PIPELINE_URL|LEARNING_CRON_KEY/)
  assert.doesNotMatch(workflow, /TUSHARE_TOKEN|QUANT_KEY/)
})

test('Actions下载FC已发布的脱敏视图后再训练', () => {
  const downloadAt = workflow.indexOf(
    'Download latest redacted training view',
  )
  const trainAt = workflow.indexOf('Train and gate challengers')

  assert.ok(downloadAt >= 0)
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
