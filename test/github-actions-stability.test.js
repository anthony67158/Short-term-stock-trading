import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const harness = read('.github/workflows/harness-ci.yml')
const retrain = read('.github/workflows/daily-retrain.yml')
const ciRequirements = read('qlib-service/requirements-ci.txt')

test('所有Python Actions共享精确版本依赖并包含TestClient运行时', () => {
  assert.match(ciRequirements, /^httpx==0\.28\.1$/m)
  assert.match(ciRequirements, /^lightgbm==4\.7\.0$/m)
  assert.match(ciRequirements, /^numpy==2\.0\.2$/m)
  assert.match(harness, /requirements-ci\.txt/)
  assert.match(retrain, /requirements-ci\.txt/)
  assert.doesNotMatch(retrain, /pip install "fastapi/)
})

test('每日学习只消费脱敏视图并训练三种子challenger', () => {
  assert.match(retrain, /^\s{2}train:/m)
  assert.match(retrain, /issues:\s*write/)
  assert.doesNotMatch(retrain, /TUSHARE_TOKEN:/)
  assert.match(retrain, /learning_pipeline\.py download/)
  assert.match(retrain, /learning_pipeline\.py train/)
  assert.match(retrain, /learning_pipeline\.py upload/)
  assert.match(retrain, /Report daily learning failure/)
  assert.match(retrain, /gh issue (create|comment)/)
  assert.match(retrain, /if \[ "\$attempt" -ge 3 \]/)
  assert.match(retrain, /Verify immutable learning contracts/)
  assert.doesNotMatch(retrain, /accounts\//)
  assert.doesNotMatch(retrain, /promote|activate-baseline|production pointer/i)
})

test('Actions总是保留诊断产物且不提供生产发布步骤', () => {
  assert.match(harness, /if-no-files-found:\s*warn/)
  assert.match(retrain, /if-no-files-found:\s*warn/)
  assert.match(retrain, /learning-artifacts\/run\/report\.json/)
  assert.doesNotMatch(retrain, /Publish selected decision release atomically/)
})
