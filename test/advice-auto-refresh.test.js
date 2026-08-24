import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dueAutoScopes,
  mergeAutoRefreshSettings,
  newerAutoRefreshPatch,
  normalizeAutoConfig,
  selectAutoRefreshCodes,
} from '../shared/adviceAutoRefreshPolicy.js'
import {
  cancelDisabledAdviceReviewJobs,
  enqueueAutoRefreshDue,
} from '../api/cron_advice.js'
import { cancelAll } from '../api/_jobs.js'
import { isAdviceReviewEnabled } from '../shared/adviceReviewPolicy.js'

test('自动刷新默认常开，持仓和自选采用不同建议频率', () => {
  const config = normalizeAutoConfig({})

  assert.equal(config.enabled, true)
  assert.equal(config.holdEnabled, true)
  assert.equal(config.holdIntervalMin, 15)
  assert.equal(config.watchEnabled, true)
  assert.equal(config.watchIntervalMin, 30)
  assert.equal(config.holdCodes, null)
  assert.equal(config.watchCodes, null)
})

test('旧账号默认复核全部，新账号显式名单只复核选中股票', () => {
  const holdings = [
    { code: '600000', name: '持仓A' },
    { code: '600001', name: '持仓B' },
  ]
  const watchlist = [
    { code: '000001', name: '自选A' },
    { code: '000002', name: '自选B', star: true },
    { code: '600000', name: '已持仓重复项' },
  ]

  assert.deepEqual(selectAutoRefreshCodes({
    config: normalizeAutoConfig({}),
    holdings,
    watchlist,
    scopes: ['hold', 'watch'],
  }), {
    holdCodes: ['600000', '600001'],
    watchCodes: ['000001', '000002'],
    allCodes: ['600000', '600001', '000001', '000002'],
  })

  assert.deepEqual(selectAutoRefreshCodes({
    config: normalizeAutoConfig({
      holdCodes: ['600001', 'invalid'],
      watchCodes: ['000002'],
    }),
    holdings,
    watchlist,
    scopes: ['hold', 'watch'],
  }), {
    holdCodes: ['600001'],
    watchCodes: ['000002'],
    allCodes: ['600001', '000002'],
  })
})

test('显式名单不会自动纳入后续新增股票', () => {
  const selected = selectAutoRefreshCodes({
    config: normalizeAutoConfig({
      holdCodes: ['600000'],
      watchCodes: [],
    }),
    holdings: [
      { code: '600000' },
      { code: '600001' },
    ],
    watchlist: [{ code: '000001' }],
    scopes: ['hold', 'watch'],
  })

  assert.deepEqual(selected.holdCodes, ['600000'])
  assert.deepEqual(selected.watchCodes, [])
  assert.equal(isAdviceReviewEnabled({
    'advAuto.holdCodes': ['600000'],
    'advAuto.watchCodes': [],
  }, '600000'), true)
  assert.equal(isAdviceReviewEnabled({
    'advAuto.holdCodes': ['600000'],
    'advAuto.watchCodes': [],
  }, '600001'), false)
})

test('持仓到期但自选未到期时只刷新持仓', () => {
  const now = 60 * 60 * 1000
  const config = normalizeAutoConfig({
    enabled: true,
    holdIntervalMin: 15,
    watchIntervalMin: 30,
    holdLastTryAt: now - 16 * 60 * 1000,
    watchLastTryAt: now - 10 * 60 * 1000,
  })

  assert.deepEqual(dueAutoScopes(config, now), ['hold'])
})

test('持仓和自选同时到期时合并为一轮刷新', () => {
  const now = 60 * 60 * 1000
  const config = normalizeAutoConfig({
    enabled: true,
    holdLastTryAt: now - 16 * 60 * 1000,
    watchLastTryAt: now - 31 * 60 * 1000,
  })

  assert.deepEqual(dueAutoScopes(config, now), ['hold', 'watch'])
})

test('关闭某一范围后该范围永不到期', () => {
  const config = normalizeAutoConfig({
    enabled: true,
    holdEnabled: false,
    watchEnabled: true,
    watchLastTryAt: 0,
  })

  assert.deepEqual(dueAutoScopes(config, Date.now()), ['watch'])
})

test('云端定时器默认创建到期的持仓和自选刷新任务', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime() // 北京时间周一 10:00
  const disabled = {
    settings: { 'advAuto.enabled': false },
    holding: [{ code: '600000', name: '持仓股' }],
    plan: [{ code: '000001', name: '自选股' }],
  }
  assert.equal(enqueueAutoRefreshDue(disabled, now), 2)

  const enabled = {
    settings: { 'advAuto.enabled': true },
    holding: [{ code: '600000', name: '持仓股' }],
    plan: [{ code: '000001', name: '自选股' }],
  }
  assert.equal(enqueueAutoRefreshDue(enabled, now), 2)
  assert.equal(enabled.reviewJobs['600000'].mode, 'hold_advice')
  assert.equal(enabled.reviewJobs['000001'].mode, 'buy_advice')
  assert.equal(enabled.activeAdviceBatchId, undefined)
  assert.equal(enqueueAutoRefreshDue(enabled, now + 5 * 60000), 0)
})

test('云端按每只股票自己的复核时间排队', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const data = {
    settings: {},
    holding: [
      { code: '600000', name: '已到期' },
      { code: '600001', name: '未到期' },
    ],
    advice: {
      '600000': { advice: { reviewCycle: { nextReviewAt: now } } },
      '600001': { advice: { reviewCycle: { nextReviewAt: now + 5 * 60000 } } },
    },
  }

  assert.equal(enqueueAutoRefreshDue(data, now), 1)
  assert.equal(data.reviewJobs['600000'].source, 'auto')
  assert.equal(data.reviewJobs['600001'], undefined)
})

test('云端定时器只为持续复核白名单中的股票排队', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const data = {
    settings: {
      'advAuto.holdCodes': ['600001'],
      'advAuto.watchCodes': ['000002'],
    },
    holding: [
      { code: '600000', name: '未选持仓' },
      { code: '600001', name: '已选持仓' },
    ],
    plan: [
      { code: '000001', name: '未选自选' },
      { code: '000002', name: '已选自选', star: true },
    ],
  }

  assert.equal(enqueueAutoRefreshDue(data, now), 2)
  assert.equal(data.reviewJobs['600000'], undefined)
  assert.equal(data.reviewJobs['000001'], undefined)
  assert.equal(data.reviewJobs['600001'].mode, 'hold_advice')
  assert.equal(data.reviewJobs['000002'].mode, 'buy_advice')
})

test('移出白名单后取消排队中的自动复核任务', () => {
  const data = {
    settings: {
      'advAuto.holdCodes': ['600001'],
      'advAuto.watchCodes': [],
    },
    holding: [
      { code: '600000' },
      { code: '600001' },
    ],
    plan: [{ code: '000001' }],
    reviewJobs: {
      '600000': {
        code: '600000',
        status: 'queued',
        source: 'auto',
      },
      '600001': {
        code: '600001',
        status: 'queued',
        source: 'auto',
      },
      '000001': {
        code: '000001',
        status: 'queued',
        source: 'auto',
      },
    },
  }

  assert.equal(cancelDisabledAdviceReviewJobs(data, 2000), 2)
  assert.equal(data.reviewJobs['600000'].status, 'canceled')
  assert.equal(data.reviewJobs['000001'].status, 'canceled')
  assert.equal(data.reviewJobs['600001'].status, 'queued')
})

test('单股关闭持续复核后云端不再创建定时任务', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const data = {
    settings: { 'advReview.disabledCodes': ['600000'] },
    holding: [
      { code: '600000', name: '关闭复核' },
      { code: '600001', name: '继续复核' },
    ],
  }

  assert.equal(enqueueAutoRefreshDue(data, now), 1)
  assert.equal(data.reviewJobs['600000'], undefined)
  assert.equal(data.reviewJobs['600001'].source, 'auto')
})

test('单股关闭持续复核后取消排队中的自动链路但保留手动生成', () => {
  const data = {
    settings: { 'advReview.disabledCodes': ['600000'] },
    jobs: {
      '600001': {
        code: '600001',
        status: 'queued',
        source: 'ondemand',
      },
    },
    reviewJobs: {
      '600000': {
        code: '600000',
        status: 'queued',
        source: 'auto',
      },
    },
  }

  assert.equal(cancelDisabledAdviceReviewJobs(data, 2000), 1)
  assert.equal(data.reviewJobs['600000'].status, 'canceled')
  assert.equal(data.jobs['600001'].status, 'queued')
})

test('每轮最多排两波自动任务并优先处理持仓，避免长队阻塞事件建议', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const data = {
    settings: {},
    holding: Array.from({ length: 8 }, (_, index) => ({
      code: `60000${index}`,
      name: `持仓${index}`,
    })),
    plan: [{ code: '000001', name: '自选股' }],
  }

  assert.equal(enqueueAutoRefreshDue(data, now), 6)
  assert.equal(Object.keys(data.reviewJobs).length, 6)
  assert.equal(data.reviewJobs['000001'], undefined)
  assert.equal(enqueueAutoRefreshDue(data, now + 5 * 60000), 0)
  assert.equal(Object.keys(data.reviewJobs).length, 6)
})

test('一次性生成运行期间仍可向独立review队列插入持续复核任务', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const data = {
    settings: {},
    holding: [{ code: '600000', name: '持仓股' }],
    jobs: {
      '000001': {
        code: '000001',
        status: 'running',
        source: 'ondemand',
        batchRequest: true,
        batchId: 'manual-batch',
      },
    },
  }

  assert.equal(enqueueAutoRefreshDue(data, now), 1)
  assert.equal(data.jobs['600000'], undefined)
  assert.equal(data.reviewJobs['600000'].source, 'auto')
  assert.equal(data.settings['advAuto.holdLastTryAt'], now)
})

test('人工全部停止后自动复核冷却三十分钟且手动任务不受限', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const data = {
    settings: {},
    holding: [{ code: '600000', name: '持仓股' }],
    jobs: {},
  }
  data.jobs.manual = {
    code: 'manual',
    status: 'running',
    source: 'ondemand',
    batchId: 'manual-batch',
  }

  assert.equal(cancelAll(data, now, 'manual-batch'), 1)
  assert.equal(
    data.adviceAutoPauseUntil,
    now + 30 * 60000,
  )
  assert.equal(
    enqueueAutoRefreshDue(data, now + 5 * 60000),
    0,
  )
  assert.equal(
    enqueueAutoRefreshDue(data, now + 31 * 60000),
    1,
  )
})

test('旧设备缺失刷新配置时不能清空云端新配置', () => {
  const previous = {
    theme: 'dark',
    'advAuto.enabled': true,
    'advAuto.holdIntervalMin': 15,
    'advAuto.holdCodes': ['600000'],
    'advAuto.watchCodes': ['000001'],
    'advAuto.configUpdatedAt': 2000,
  }
  const incoming = { theme: 'light' }

  assert.deepEqual(mergeAutoRefreshSettings(previous, incoming), {
    theme: 'light',
    'advAuto.enabled': true,
    'advAuto.holdIntervalMin': 15,
    'advAuto.holdCodes': ['600000'],
    'advAuto.watchCodes': ['000001'],
    'advAuto.configUpdatedAt': 2000,
  })
})

test('交易冲突时仍可独立保存更新时间更晚的刷新配置', () => {
  const previous = {
    'advAuto.enabled': false,
    'advAuto.configUpdatedAt': 1000,
  }
  const incoming = {
    'advAuto.enabled': true,
    'advAuto.holdIntervalMin': 15,
    'advAuto.holdCodes': ['600000'],
    'advAuto.watchIntervalMin': 30,
    'advAuto.watchCodes': ['000001'],
    'advAuto.configUpdatedAt': 2000,
  }

  assert.deepEqual(newerAutoRefreshPatch(previous, incoming), incoming)
  assert.equal(newerAutoRefreshPatch(incoming, previous), null)
})

test('单股复核开关按配置更新时间跨设备合并', () => {
  const previous = {
    'advReview.disabledCodes': ['600000'],
    'advAuto.configUpdatedAt': 1000,
  }
  const incoming = {
    'advReview.disabledCodes': [],
    'advAuto.configUpdatedAt': 2000,
  }

  assert.deepEqual(
    mergeAutoRefreshSettings(previous, incoming),
    incoming,
  )
  assert.deepEqual(
    newerAutoRefreshPatch(previous, incoming),
    incoming,
  )
})
