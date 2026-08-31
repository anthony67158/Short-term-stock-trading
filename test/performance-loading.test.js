import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  clearAccountSnapshotCache,
  readAccountSnapshotCache,
  writeAccountSnapshotCache,
} from '../src/accountSnapshotCache.js'
import {
  clearPollingCache,
  loadPollingResource,
  readPollingCache,
} from '../src/pollingCache.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('账号快照缓存按账号和有效期恢复，登出后清除', () => {
  const storage = memoryStorage()
  const snapshot = {
    data: { holding: [{ code: '003036' }] },
    updatedAt: 100,
    revision: 4,
  }
  assert.equal(writeAccountSnapshotCache('测试账号', snapshot, {
    storage,
    now: 1000,
  }), true)
  assert.deepEqual(
    readAccountSnapshotCache('测试账号', {
      storage,
      now: 2000,
      maxAgeMs: 5000,
    })?.data,
    snapshot.data,
  )
  assert.equal(readAccountSnapshotCache('其他账号', { storage }), null)
  assert.equal(readAccountSnapshotCache('测试账号', {
    storage,
    now: 7000,
    maxAgeMs: 5000,
  }), null)
  clearAccountSnapshotCache('测试账号', { storage })
  assert.equal(readAccountSnapshotCache('测试账号', { storage }), null)
})

test('详情短缓存合并同一资源的并发请求并支持后台重验', async () => {
  clearPollingCache()
  let calls = 0
  const loader = async () => {
    calls += 1
    return { ok: true, candles: [{ close: calls }] }
  }

  const [left, right] = await Promise.all([
    loadPollingResource('detail:003036', loader, {
      ttlMs: 120000,
      preferCache: false,
    }),
    loadPollingResource('detail:003036', loader, {
      ttlMs: 120000,
      preferCache: false,
    }),
  ])
  assert.equal(calls, 1)
  assert.deepEqual(left, right)
  assert.equal(readPollingCache('detail:003036', 120000), left)

  await loadPollingResource('detail:003036', loader, {
    ttlMs: 120000,
    preferCache: false,
  })
  assert.equal(calls, 2)
})

test('个股详情代码和行情在点击时并行预取，主包不再静态加载图表', () => {
  const app = read('src/App.jsx')
  const detailStore = read('src/detailStore.js')
  const detail = read('src/components/StockDetail.jsx')

  assert.doesNotMatch(app, /import StockDetail from/)
  assert.match(
    app,
    /const StockDetail = lazyWithReload\(loadStockDetailComponent/,
  )
  assert.match(app, /<Suspense[\s\S]*?<StockDetailSkeleton/)
  assert.match(
    detailStore,
    /open\(stock\)[\s\S]*?preloadStockDetailExperience\(stock\.code\)[\s\S]*?emit\(\)/,
  )
  assert.match(detail, /cacheTtlMs:\s*STOCK_DETAIL_CACHE_TTL_MS/)
})

test('账号缓存只做临时展示，云端校验前不触发账本结算与回存', () => {
  const authStore = read('src/authStore.js')
  const planStore = read('src/planStore.js')

  assert.match(
    authStore,
    /planStore\.setData\(cached\.data,\s*\{\s*provisional:\s*true\s*}\)/,
  )
  assert.match(
    planStore,
    /if \(!options\.provisional\) this\.autoSettleTFlows\(\)/,
  )
})
