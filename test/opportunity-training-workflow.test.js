import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const workflow = read('.github/workflows/daily-retrain.yml')
const exporter = read('scripts/export-opportunity-outcomes.mjs')

test('V3每日重训直接发布模型，晋级保留为后置诊断', () => {
  assert.match(workflow, /opportunity-retrain:/)
  assert.match(workflow, /collect_opportunity_outcomes\.py/)
  assert.match(workflow, /train_opportunity_score\.py/)
  assert.match(
    workflow,
    /--directory opportunity-model\/shadow[\s\S]*?--prefix opportunitymodel\//,
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

test('直接发布不等待晋级结果且V3样本允许导出', () => {
  const shadowStep = workflow.match(
    /- name: Publish current V3 model directly without promotion prerequisite([\s\S]*?)(?=\n      - name:)/,
  )?.[1] || ''
  assert.match(shadowStep, /--prefix opportunitymodel\/\s*(?:\n|$)/)
  assert.doesNotMatch(shadowStep, /eligible.*true|promotion_decision/)
  assert.match(exporter, /opportunity-score-feature\.v3/)
})
