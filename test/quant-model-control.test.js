import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyModelSelection,
  canControlV2Service,
  getV2RuntimeConfig,
  getV2ServiceStatus,
  getProductionModelMetrics,
  modelControlView,
  normalizeProductionModelMetrics,
  resolveV2ServiceStatus,
  setV2ServiceEnabled,
} from '../api/_quant_model_control.js'

const controlSource = readFileSync(
  new URL('../api/_quant_model_control.js', import.meta.url),
  'utf8',
)

test('EAS SDK显式使用已发布的dist入口避免Node20回退index.js', () => {
  assert.match(
    controlSource,
    /@alicloud\/eas20210701\/dist\/client\.js/,
  )
})

test('生产模型元数据以样本外AUC展示泛化准确性且不泄露内部配置', () => {
  const metrics = normalizeProductionModelMetrics({
    loaded: true,
    meta: {
      holdout_auc: 0.5739396428725843,
      cv_auc: 0.6091897079763262,
      n_samples: 360890,
      data_end_date: '2026-08-06',
      feat_names: Array.from({ length: 36 }, (_, index) => `f${index}`),
      horizon: 5,
      secret: 'must-not-leak',
    },
  })

  assert.deepEqual(metrics, {
    available: true,
    loaded: true,
    primaryLabel: '样本外 AUC',
    primaryAucPct: 57.39,
    holdoutAucPct: 57.39,
    cvAucPct: 60.92,
    sampleCount: 360890,
    dataEndDate: '2026-08-06',
    featureCount: 36,
    horizonDays: 5,
  })
  assert.equal(JSON.stringify(metrics).includes('must-not-leak'), false)
})

test('生产模型准确率从量化服务读取且服务失败时安全降级', async () => {
  const success = await getProductionModelMetrics({
    env: {
      QUANT_URL: 'https://quant.example.com/',
      QUANT_KEY: 'private-key',
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://quant.example.com/model_info')
      assert.equal(options.headers['X-API-Key'], 'private-key')
      return {
        ok: true,
        async json() {
          return {
            loaded: true,
            meta: { holdout_auc: 0.58, feat_names: ['a', 'b'] },
          }
        },
      }
    },
  })
  assert.equal(success.primaryAucPct, 58)

  const unavailable = await getProductionModelMetrics({
    env: { QUANT_URL: 'https://quant.example.com' },
    fetchImpl: async () => { throw new Error('network down') },
  })
  assert.deepEqual(unavailable, {
    available: false,
    loaded: false,
    primaryLabel: '样本外 AUC',
    primaryAucPct: null,
    holdoutAucPct: null,
    cvAucPct: null,
    sampleCount: null,
    dataEndDate: '',
    featureCount: null,
    horizonDays: null,
  })
})

test('默认模型无需V2开关且始终可用', () => {
  const view = modelControlView({
    settings: { quantModelVersion: 'default' },
  }, { v2Status: 'Stopped' })

  assert.equal(view.selected, 'default')
  assert.equal(view.available, true)
  assert.equal(view.showV2Switch, false)
})

test('切换到V2但服务未运行时不可调用', () => {
  const data = { settings: {} }
  applyModelSelection(data, 'v2', 123)
  const view = modelControlView(data, { v2Status: 'Stopped' })

  assert.equal(data.settings.quantModelVersion, 'v2')
  assert.equal(data.settings.quantModelUpdatedAt, 123)
  assert.equal(view.available, false)
  assert.equal(view.showV2Switch, true)
  assert.equal(view.v2Enabled, false)
})

test('V2.1是手动选择的实验版本并复用分钟模型服务开关', () => {
  const data = { settings: {} }
  applyModelSelection(data, 'v2.1', 456)
  const view = modelControlView(data, {
    v2Status: 'Running',
    canControlV2: true,
  })

  assert.equal(view.selected, 'v2.1')
  assert.equal(view.label, '分钟 Transformer V2.1（盘中实验）')
  assert.equal(view.available, true)
  assert.equal(view.showV2Switch, true)
  assert.equal(view.experimental, true)
  assert.equal(view.v2Enabled, true)
})

test('V2启动中状态会明确标记为过渡态', () => {
  const view = modelControlView({
    settings: { quantModelVersion: 'v2' },
  }, { v2Status: 'Waiting', canControlV2: true })

  assert.equal(view.v2Enabled, false)
  assert.equal(view.v2Starting, true)
  assert.equal(view.v2Stopping, false)
  assert.equal(view.v2Transitioning, true)
})

test('V2启停提交后立即返回过渡状态，不因状态回读超时报错', async () => {
  const calls = []
  const client = {
    async startService(cluster, name) {
      calls.push(['start', cluster, name])
    },
    async stopService(cluster, name) {
      calls.push(['stop', cluster, name])
    },
  }

  const started = await setV2ServiceEnabled(true, { client })
  assert.equal(started.status, 'Starting')
  assert.deepEqual(calls[0], ['start', 'cn-hangzhou', 'stock_quant_lab_shadow'])
  assert.equal(calls.length, 1)

  calls.length = 0
  const stopped = await setV2ServiceEnabled(false, { client })
  assert.equal(stopped.status, 'Stopping')
  assert.deepEqual(calls[0], ['stop', 'cn-hangzhou', 'stock_quant_lab_shadow'])
  assert.equal(calls.length, 1)
})

test('EAS状态查询会重试瞬时控制面超时', async () => {
  let attempts = 0
  const status = await getV2ServiceStatus({
    client: {
      async describeService() {
        attempts++
        if (attempts < 3) throw new Error('ConnectTimeout')
        return { body: { status: 'Running' } }
      },
    },
    sleepImpl: async () => {},
  })

  assert.equal(status, 'Running')
  assert.equal(attempts, 3)
})

test('EAS运行配置会规范化当前服务入口并返回实时Token', async () => {
  const runtime = await getV2RuntimeConfig({
    client: {
      async describeService() {
        return {
          body: {
            status: 'Running',
            internetEndpoint: 'current.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
            accessToken: 'current-token',
            serviceConfig: JSON.stringify({
              containers: [{
                env: [
                  { name: 'SHADOW_API_KEY', value: 'current-shadow-key' },
                ],
              }],
            }),
          },
        }
      },
    },
  })

  assert.deepEqual(runtime, {
    url: 'https://current.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
    easToken: 'current-token',
    apiKey: 'current-shadow-key',
    status: 'Running',
  })
})

test('启动命令已受理时状态回读失败回退为启动中', async () => {
  const status = await resolveV2ServiceStatus('Starting', {
    getStatus: async () => { throw new Error('ReadTimeout') },
  })

  assert.equal(status, 'Starting')
})

test('只有部署白名单账号可以控制共享V2服务', () => {
  const account = { nick: '已有账号' }
  const hashAccount = () => 'allowed'

  assert.equal(canControlV2Service(account, {
    env: { AUTHORIZED_ACCOUNT_HASHES: 'allowed' },
    hashAccount,
  }), true)
  assert.equal(canControlV2Service(account, {
    env: { AUTHORIZED_ACCOUNT_HASHES: 'another' },
    hashAccount,
  }), false)
})
