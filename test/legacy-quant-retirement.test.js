import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('Transformer V2与V2.1运行时入口已完全下线', () => {
  for (const path of [
    'api/_v2_quant.js',
    'api/_quant_model_control.js',
    'api/quant_model.js',
    'api/cron_v2_accuracy.js',
    'src/quantModelStore.js',
    'src/components/QuantModelControl.jsx',
    'qlib-service/intraday_shadow_app.py',
    'qlib-service/train_intraday_v21.py',
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, path)
  }

  const app = read('src/App.jsx')
  const accountMenu = read('src/components/AuthGate.jsx')
  const deployment = read('s.yaml')
  const runtimePackage = read('fc-runtime/package.json')
  assert.doesNotMatch(app, /QuantModelControl|quantModelStore/)
  assert.doesNotMatch(accountMenu, /量化模型配置|quantModelStore/)
  assert.doesNotMatch(
    deployment,
    /V2_QUANT_URL|V2_EAS_TOKEN|V2_API_KEY|v2-accuracy-timer/,
  )
  assert.doesNotMatch(runtimePackage, /@alicloud\/eas20210701/)
})

test('每日训练继续保留V3三种子集成与直接发布', () => {
  const workflow = read('.github/workflows/daily-retrain.yml')
  assert.match(workflow, /train_opportunity_seed_ensemble\.py/)
  assert.match(workflow, /poc_v3_seed_ensemble\.py/)
  assert.match(workflow, /--activate-baseline/)
  assert.doesNotMatch(
    workflow,
    /train_intraday|intraday_v21|predict-v2/,
  )
})
