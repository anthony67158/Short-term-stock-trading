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

test('重训主模型与板块模型分离运行并使用明确OSS公网出口', () => {
  assert.match(retrain, /^\s{2}verify:/m)
  assert.match(retrain, /^\s{2}stock-retrain:/m)
  assert.match(retrain, /^\s{2}sector-retrain:/m)
  assert.match(retrain, /needs:\s*verify/)
  assert.match(retrain, /OSS_ALLOW_PUBLIC_NETWORK:\s*"true"/)
  assert.match(
    retrain,
    /OSS_ENDPOINT:\s*https:\/\/oss-cn-hangzhou\.aliyuncs\.com/,
  )
  assert.match(retrain, /Verify stock model OSS connectivity/)
  assert.match(retrain, /Verify sector model OSS connectivity/)
  assert.match(retrain, /Preflight - Tushare板块数据源/)
  assert.match(retrain, /TushareClient\(timeout=20, retries=1\)/)
  assert.match(retrain, /except urllib\.error\.HTTPError as error:/)
  assert.match(
    retrain,
    /except \(urllib\.error\.URLError, TimeoutError, ConnectionError\) as error:/,
  )
  assert.match(retrain, /Skip sector retrain \(数据源不可达\)/)
})

test('Actions总是保留诊断产物且发布报告失败不遮蔽训练结果', () => {
  assert.match(harness, /if-no-files-found:\s*warn/)
  assert.match(retrain, /if-no-files-found:\s*warn/)
  assert.match(
    retrain,
    /Publish result to in-app quant report[\s\S]*continue-on-error:\s*true/,
  )
})
