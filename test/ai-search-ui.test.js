import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeAiSearchPublicConfig,
  visibleAiSources,
  visibleSearchReference,
} from '../shared/aiSearchUi.js'

test('前端AI检索配置只接受安全公开字段', () => {
  const config = normalizeAiSearchPublicConfig({
    enabled: true,
    hasKey: true,
    apiKeyMask: '2NW*********8GbH',
    apiKey: 'secret-must-not-survive',
    provider: 'doubao-global',
    keyName: 'stock',
    limits: {
      qps: 5,
      freeCallsPerMonth: 500,
    },
    updatedAt: 123,
    cachePolicy: {
      stockMinutes: 30,
      industryMinutes: 240,
      industryFailureCooldownMinutes: 15,
      scheduledCacheOnly: true,
    },
  })

  assert.deepEqual(config, {
    enabled: true,
    hasKey: true,
    apiKeyMask: '2NW*********8GbH',
    provider: 'doubao-global',
    keyName: 'stock',
    limits: {
      qps: 5,
      freeCallsPerMonth: 500,
    },
    updatedAt: 123,
    cachePolicy: {
      stockMinutes: 30,
      industryMinutes: 240,
      industryFailureCooldownMinutes: 15,
      scheduledCacheOnly: true,
    },
  })
  assert.equal('apiKey' in config, false)
})

test('关闭开关后生成进度不展示豆包联网搜索来源', () => {
  const sources = [
    { label: '实时行情', ok: true },
    { label: '豆包联网搜索', ok: true },
  ]

  assert.deepEqual(visibleAiSources(false, sources), [sources[0]])
  assert.deepEqual(visibleAiSources(true, sources), sources)
})

test('关闭开关后立即隐藏旧结果中的检索参考维度', () => {
  const reference = {
    dimension: 'search',
    label: '检索参考',
    sources: [{ title: '行业订单回升' }],
  }

  assert.equal(visibleSearchReference(false, reference), null)
  assert.equal(visibleSearchReference(true, reference), reference)
  assert.equal(visibleSearchReference(true, { dimension: 'data' }), null)
})
