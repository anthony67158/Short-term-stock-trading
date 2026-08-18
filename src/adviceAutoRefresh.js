// 军师持续复核配置与浏览器手动刷新。
// 自动调度由 FC Timer 执行；浏览器只维护跨设备配置并保留立即刷新入口。
import { planStore } from './planStore'
import { runBatchAdvice, isBatchRunning } from './adviceBatch'
import {
  DEFAULT_HOLD_INTERVAL,
  DEFAULT_WATCH_INTERVAL,
  MAX_AUTO_INTERVAL,
  MIN_AUTO_INTERVAL,
  AUTO_CONFIG_UPDATED_AT,
  autoConfigFromSettings,
} from '../shared/adviceAutoRefreshPolicy'

export const K_HOLD_ENABLED = 'advAuto.holdEnabled'
export const K_HOLD_INTERVAL = 'advAuto.holdIntervalMin'
export const K_HOLD_LAST = 'advAuto.holdLastAt'
export const K_HOLD_LASTTRY = 'advAuto.holdLastTryAt'
export const K_WATCH_ENABLED = 'advAuto.watchEnabled'
export const K_WATCH_INTERVAL = 'advAuto.watchIntervalMin'
export const K_WATCH_LAST = 'advAuto.watchLastAt'
export const K_WATCH_LASTTRY = 'advAuto.watchLastTryAt'

export const DEFAULT_HOLD = DEFAULT_HOLD_INTERVAL
export const DEFAULT_WATCH = DEFAULT_WATCH_INTERVAL
export const MIN_INTERVAL = MIN_AUTO_INTERVAL
export const MAX_INTERVAL = MAX_AUTO_INTERVAL

export function setAutoConfigSetting(key, value) {
  planStore.setSetting(key, value)
  planStore.setSetting(AUTO_CONFIG_UPDATED_AT, Date.now())
}

export function getAutoConfig() {
  return autoConfigFromSettings(planStore.get().settings || {})
}

function codesForScopes(scopes) {
  const st = planStore.get()
  const holdCodes = [...new Set((st.holding || []).map((item) => item.code))]
  const holdSet = new Set(holdCodes)
  const watchCodes = [...new Set((st.plan || []).map((item) => item.code))]
    .filter((code) => !holdSet.has(code))
  const scopeSet = new Set(scopes)
  return [
    ...(scopeSet.has('hold') ? holdCodes : []),
    ...(scopeSet.has('watch') ? watchCodes : []),
  ]
}

function markTry(scopes, at) {
  if (scopes.includes('hold')) planStore.setSetting(K_HOLD_LASTTRY, at)
  if (scopes.includes('watch')) planStore.setSetting(K_WATCH_LASTTRY, at)
}

function markStarted(scopes, at) {
  if (scopes.includes('hold')) planStore.setSetting(K_HOLD_LAST, at)
  if (scopes.includes('watch')) planStore.setSetting(K_WATCH_LAST, at)
}

let running = false

async function startRefresh(scopes, quoteMap, { manual = false } = {}) {
  if (running || isBatchRunning()) return { status: 'running' }
  const codes = codesForScopes(scopes)
  if (!codes.length) return { status: 'empty' }

  running = true
  const now = Date.now()
  markTry(scopes, now)
  try {
    const result = await runBatchAdvice(codes, quoteMap || {}, { force: true })
    if (result?.status === 'started') markStarted(scopes, Date.now())
    return { ...result, manual }
  } finally {
    running = false
  }
}

export async function runManualAdviceRefresh(scope = 'both', quoteMap = {}) {
  const scopes = scope === 'hold' ? ['hold'] : scope === 'watch' ? ['watch'] : ['hold', 'watch']
  return startRefresh(scopes, quoteMap, { manual: true })
}
