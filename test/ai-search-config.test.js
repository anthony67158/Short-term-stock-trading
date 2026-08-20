import test from 'node:test'
import assert from 'node:assert/strict'

import {
  envAiSearchConfig,
  mergeAiSearchConfig,
  publicAiSearchConfig,
  saveAiSearchConfig,
  updateAiSearchConfig,
} from '../api/_ai_search_config.js'

test('AI检索配置以OSS为准并回退环境变量Key', () => {
  const config = mergeAiSearchConfig(
    {
      enabled: true,
      apiKey: 'env-key-1234567890123456',
      keyName: 'stock',
      source: 'env',
      updatedAt: 0,
    },
    {
      enabled: false,
      apiKey: '',
      updatedAt: 123,
      __stored: true,
    },
  )

  assert.equal(config.enabled, false)
  assert.equal(config.apiKey, 'env-key-1234567890123456')
  assert.equal(config.keyName, 'stock')
  assert.equal(config.source, 'oss')
  assert.equal(config.updatedAt, 123)
})

test('保存配置覆盖固定OSS对象且公开响应不含明文Key', async () => {
  let written = null
  const saved = await saveAiSearchConfig({
    enabled: true,
    apiKey: 'saved-key-1234567890123456',
    keyName: 'stock',
  }, {
    now: 600,
    storage: {
      hasStorage: () => true,
      readJson: async () => null,
      put: async (path, body, options) => {
        written = { path, body: JSON.parse(body), options }
      },
    },
  })

  assert.equal(written.path, 'config/doubao-search.json')
  assert.equal(written.body.apiKey, 'saved-key-1234567890123456')
  assert.equal(written.body.keyName, 'stock')
  assert.equal(written.options.addRandomSuffix, false)
  assert.equal(publicAiSearchConfig(saved).apiKey, undefined)
})

test('公开配置只返回掩码和缓存策略，绝不返回明文Key', () => {
  const view = publicAiSearchConfig({
    enabled: true,
    apiKey: 'secret-value-1234567890123456',
    keyName: 'stock',
    source: 'oss',
    updatedAt: 456,
  })

  assert.equal(view.enabled, true)
  assert.equal(view.hasKey, true)
  assert.match(view.apiKeyMask, /^sec\*+/)
  assert.equal(JSON.stringify(view).includes('secret-value'), false)
  assert.equal(view.provider, 'doubao-global')
  assert.equal(view.keyName, 'stock')
  assert.deepEqual(view.limits, {
    qps: 5,
    freeCallsPerMonth: 500,
  })
  assert.deepEqual(view.cachePolicy, {
    stockMinutes: 30,
    industryMinutes: 240,
    industryFailureCooldownMinutes: 15,
    scheduledCacheOnly: true,
  })
})

test('切换开关保留旧Key，更换Key时校验格式并更新版本', () => {
  const current = {
    enabled: true,
    apiKey: 'current-key-1234567890123456',
    keyName: 'stock',
    source: 'oss',
    updatedAt: 100,
  }
  const disabled = updateAiSearchConfig(current, {
    enabled: false,
    apiKey: '',
  }, 200)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.apiKey, current.apiKey)
  assert.equal(disabled.updatedAt, 200)

  const replaced = updateAiSearchConfig(disabled, {
    apiKey: 'replaced-key-1234567890123456',
    keyName: 'stock',
  }, 300)
  assert.equal(replaced.apiKey, 'replaced-key-1234567890123456')
  assert.equal(replaced.updatedAt, 300)

  assert.throws(
    () => updateAiSearchConfig(current, { apiKey: 'not-a-key' }, 400),
    /Key 格式无效/,
  )
  assert.throws(
    () => updateAiSearchConfig({
      enabled: false,
      apiKey: '',
    }, { enabled: true }, 500),
    /先配置 API Key/,
  )
})

test('豆包配置读取DOUBAO环境变量和Key名称', () => {
  const config = envAiSearchConfig({
    DOUBAO_SEARCH_ENABLED: 'true',
    DOUBAO_SEARCH_API_KEY: 'doubao-key-1234567890123456',
    DOUBAO_SEARCH_KEY_NAME: 'stock',
  })

  assert.equal(config.enabled, true)
  assert.equal(config.apiKey, 'doubao-key-1234567890123456')
  assert.equal(config.keyName, 'stock')
})
