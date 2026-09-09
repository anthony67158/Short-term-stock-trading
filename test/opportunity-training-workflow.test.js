import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const workflow = read('.github/workflows/daily-retrain.yml')
const exporter = read('scripts/export-opportunity-outcomes.mjs')

test('V3每日重训包含采集、训练、影子发布、晋级和状态发布', () => {
  assert.match(workflow, /opportunity-retrain:/)
  assert.match(workflow, /collect_opportunity_outcomes\.py/)
  assert.match(workflow, /train_opportunity_score\.py/)
  assert.match(
    workflow,
    /--prefix opportunitymodel\/shadow\//,
  )
  assert.match(workflow, /--check-only/)
  assert.match(workflow, /promotion_decision\.json/)
  assert.match(
    workflow,
    /--directory opportunity-model\/production[\s\S]*?--prefix opportunitymodel\//,
  )
  assert.match(
    workflow,
    /publish_opportunity_training_status\.py/,
  )
})

test('影子发布不能覆盖生产模型入口且V3样本允许导出', () => {
  const shadowStep = workflow.match(
    /- name: Publish eligible shadow model to isolated channel([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''
  assert.match(shadowStep, /opportunitymodel\/shadow\//)
  assert.doesNotMatch(
    shadowStep,
    /--prefix opportunitymodel\/\s*(?:\n|$)/,
  )
  assert.match(exporter, /opportunity-score-feature\.v3/)
})
