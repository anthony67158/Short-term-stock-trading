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

test('日线辅助模型与决策模型分离运行且每日流程不依赖Tushare', () => {
  assert.match(retrain, /^\s{2}verify:/m)
  assert.match(retrain, /^\s{2}stock-retrain:/m)
  assert.match(retrain, /^\s{2}opportunity-retrain:/m)
  assert.doesNotMatch(retrain, /^\s{2}sector-retrain:/m)
  assert.doesNotMatch(retrain, /TUSHARE_TOKEN:/)
  assert.match(retrain, /needs:\s*verify/)
  assert.match(retrain, /OSS_ALLOW_PUBLIC_NETWORK:\s*"true"/)
  assert.match(
    retrain,
    /OSS_ENDPOINT:\s*https:\/\/oss-cn-hangzhou\.aliyuncs\.com/,
  )
  assert.match(retrain, /Verify stock model OSS connectivity/)
  assert.match(retrain, /Collect mature opportunity outcomes/)
  assert.match(retrain, /Run three-seed LightGBM and CatBoost walk-forward/)
  assert.match(retrain, /Train and evaluate opportunity challenger/)
  assert.match(retrain, /Download current production decision model as champion/)
  assert.match(retrain, /Select improved decision heads and validate the whole model/)
  assert.match(retrain, /Publish selected decision release atomically/)
  assert.match(retrain, /--activate-baseline/)
  assert.match(
    retrain,
    /if: steps\.opportunity-selection\.outputs\.publish == 'true'/,
  )
  assert.match(retrain, /Archive latest completed market day from public sources/)
  assert.match(retrain, /archive-market-day/)
})

test('Actions总是保留诊断产物且发布报告失败不遮蔽训练结果', () => {
  assert.match(harness, /if-no-files-found:\s*warn/)
  assert.match(retrain, /if-no-files-found:\s*warn/)
  assert.match(
    retrain,
    /Publish decision-model result to in-app quant report[\s\S]*continue-on-error:\s*true/,
  )
})
