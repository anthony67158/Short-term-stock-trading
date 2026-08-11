import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyModelSelection,
  canControlV2Service,
  getV2ServiceStatus,
  modelControlView,
  resolveV2ServiceStatus,
  setV2ServiceEnabled,
} from '../api/_quant_model_control.js'

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
