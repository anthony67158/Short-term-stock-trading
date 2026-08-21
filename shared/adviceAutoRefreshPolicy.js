export const DEFAULT_HOLD_INTERVAL = 15
export const DEFAULT_WATCH_INTERVAL = 30
export const MIN_AUTO_INTERVAL = 5
export const MAX_AUTO_INTERVAL = 240
export const AUTO_CONFIG_UPDATED_AT = 'advAuto.configUpdatedAt'
export const ADVICE_REVIEW_DISABLED_CODES = 'advReview.disabledCodes'
export const AUTO_HOLD_CODES = 'advAuto.holdCodes'
export const AUTO_WATCH_CODES = 'advAuto.watchCodes'
export const AUTO_CONFIG_KEYS = [
  'advAuto.enabled',
  'advAuto.holdEnabled',
  'advAuto.holdIntervalMin',
  AUTO_HOLD_CODES,
  'advAuto.watchEnabled',
  'advAuto.watchIntervalMin',
  AUTO_WATCH_CODES,
  ADVICE_REVIEW_DISABLED_CODES,
]

function interval(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(MIN_AUTO_INTERVAL, Math.min(MAX_AUTO_INTERVAL, Math.trunc(n)))
}

function codeList(value) {
  if (!Array.isArray(value)) return null
  return [...new Set(value
    .map((code) => String(code || '').trim())
    .filter((code) => /^\d{6}$/.test(code)))]
    .slice(0, 500)
}

export function normalizeAutoConfig(input = {}) {
  return {
    enabled: true,
    holdEnabled: input.holdEnabled !== false,
    holdIntervalMin: interval(input.holdIntervalMin, DEFAULT_HOLD_INTERVAL),
    holdLastAt: Number(input.holdLastAt) || 0,
    holdLastTryAt: Number(input.holdLastTryAt) || 0,
    holdCodes: codeList(input.holdCodes),
    watchEnabled: input.watchEnabled !== false,
    watchIntervalMin: interval(input.watchIntervalMin, DEFAULT_WATCH_INTERVAL),
    watchLastAt: Number(input.watchLastAt) || 0,
    watchLastTryAt: Number(input.watchLastTryAt) || 0,
    watchCodes: codeList(input.watchCodes),
  }
}

export function autoConfigFromSettings(settings = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(settings, key)
  const legacyScope = ['hold', 'watch', 'both'].includes(settings['advAuto.scope'])
    ? settings['advAuto.scope']
    : 'both'
  const hasLegacy = has('advAuto.intervalMin') || has('advAuto.scope')
  const legacyInterval = Number(settings['advAuto.intervalMin'])
  const legacyLast = Number(settings['advAuto.lastAt']) || 0
  const legacyLastTry = Number(settings['advAuto.lastTryAt']) || 0
  return normalizeAutoConfig({
    enabled: true,
    holdEnabled: has('advAuto.holdEnabled')
      ? settings['advAuto.holdEnabled'] !== false
      : (hasLegacy ? legacyScope !== 'watch' : true),
    holdIntervalMin: has('advAuto.holdIntervalMin')
      ? settings['advAuto.holdIntervalMin']
      : (Number.isFinite(legacyInterval) ? legacyInterval : DEFAULT_HOLD_INTERVAL),
    holdLastAt: settings['advAuto.holdLastAt'] ?? legacyLast,
    holdLastTryAt: settings['advAuto.holdLastTryAt'] ?? legacyLastTry,
    holdCodes: has(AUTO_HOLD_CODES)
      ? settings[AUTO_HOLD_CODES]
      : null,
    watchEnabled: has('advAuto.watchEnabled')
      ? settings['advAuto.watchEnabled'] !== false
      : (hasLegacy ? legacyScope !== 'hold' : true),
    watchIntervalMin: has('advAuto.watchIntervalMin')
      ? settings['advAuto.watchIntervalMin']
      : (Number.isFinite(legacyInterval) ? legacyInterval : DEFAULT_WATCH_INTERVAL),
    watchLastAt: settings['advAuto.watchLastAt'] ?? legacyLast,
    watchLastTryAt: settings['advAuto.watchLastTryAt'] ?? legacyLastTry,
    watchCodes: has(AUTO_WATCH_CODES)
      ? settings[AUTO_WATCH_CODES]
      : null,
  })
}

function uniqueCodes(items = []) {
  return [...new Set(items
    .map((item) => String(item?.code || '').trim())
    .filter((code) => /^\d{6}$/.test(code)))]
}

function selectedCodes(available, configured) {
  if (!Array.isArray(configured)) return available
  const selected = new Set(configured)
  return available.filter((code) => selected.has(code))
}

export function selectAutoRefreshCodes({
  config = {},
  holdings = [],
  watchlist = [],
  scopes = ['hold', 'watch'],
} = {}) {
  const scopeSet = new Set(scopes)
  const availableHoldCodes = uniqueCodes(holdings)
  const holdSet = new Set(availableHoldCodes)
  const availableWatchCodes = uniqueCodes(watchlist)
    .filter((code) => !holdSet.has(code))
  const holdCodes = scopeSet.has('hold') && config.holdEnabled !== false
    ? selectedCodes(availableHoldCodes, config.holdCodes)
    : []
  const watchCodes = scopeSet.has('watch') && config.watchEnabled !== false
    ? selectedCodes(availableWatchCodes, config.watchCodes)
    : []
  return {
    holdCodes,
    watchCodes,
    allCodes: [...holdCodes, ...watchCodes],
  }
}

export function dueAutoScopes(config, now = Date.now()) {
  if (!config?.enabled) return []
  const due = []
  if (
    config.holdEnabled
    && (!config.holdLastTryAt || now - config.holdLastTryAt >= config.holdIntervalMin * 60000)
  ) due.push('hold')
  if (
    config.watchEnabled
    && (!config.watchLastTryAt || now - config.watchLastTryAt >= config.watchIntervalMin * 60000)
  ) due.push('watch')
  return due
}

export function mergeAutoRefreshSettings(previous = {}, incoming = {}) {
  const merged = { ...previous, ...incoming }
  const previousAt = Number(previous[AUTO_CONFIG_UPDATED_AT]) || 0
  const incomingAt = Number(incoming[AUTO_CONFIG_UPDATED_AT]) || 0
  if (previousAt > incomingAt) {
    for (const key of AUTO_CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(previous, key)) merged[key] = previous[key]
      else delete merged[key]
    }
    if (previousAt) merged[AUTO_CONFIG_UPDATED_AT] = previousAt
  }
  return merged
}

export function newerAutoRefreshPatch(previous = {}, incoming = {}) {
  const previousAt = Number(previous[AUTO_CONFIG_UPDATED_AT]) || 0
  const incomingAt = Number(incoming[AUTO_CONFIG_UPDATED_AT]) || 0
  if (!(incomingAt > previousAt)) return null
  const patch = { [AUTO_CONFIG_UPDATED_AT]: incomingAt }
  for (const key of AUTO_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) patch[key] = incoming[key]
  }
  return patch
}
