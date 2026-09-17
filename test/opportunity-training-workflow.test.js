import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const workflow = read('.github/workflows/daily-retrain.yml')
const trainer = read('qlib-service/learning_pipeline.py')
const exporter = read('scripts/export-opportunity-outcomes.mjs')

test('选股与持仓challenger使用时间外三种子门禁', () => {
  assert.match(trainer, /SEEDS = \(17, 41, 97\)/)
  assert.match(trainer, /class Gate/)
  assert.match(trainer, /train_stock_pick/)
  assert.match(trainer, /train_position/)
  assert.match(trainer, /_split\(rows\)/)
  assert.match(trainer, /minimumSeedTop5ReturnPct/)
  assert.match(trainer, /maximumSeedMaeR/)
})

test('样本不足与性能不增量时均不得产出可晋级结果', () => {
  assert.match(trainer, /SKIPPED_INSUFFICIENT_MATURED_DATA/)
  assert.match(trainer, /CHALLENGER_REJECTED/)
  assert.match(trainer, /stock_pick_samples_below_60/)
  assert.match(trainer, /position_samples_below_30/)
  assert.match(trainer, /productionPointerChanged": False/)
  assert.doesNotMatch(workflow, /activate-baseline|production\/current/)
})

test('训练产物只上传不可变training-runs目录', () => {
  assert.match(
    trainer,
    /learning\/v1\/training-runs\/\{report\['generatedAt'\]\[:10\]\}/,
  )
  assert.match(trainer, /x-oss-forbid-overwrite/)
  assert.match(workflow, /Upload immutable challenger run/)
  assert.doesNotMatch(workflow, /upload_review_model|upload_decision_model/)
})

test('旧机会结果导出合同保留但不再控制每日生产发布', () => {
  assert.match(exporter, /opportunity-score-feature\.v5/)
  assert.doesNotMatch(workflow, /collect_opportunity_outcomes\.py/)
  assert.doesNotMatch(workflow, /decision_engine\.training\.release/)
})
