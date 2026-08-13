export const DEFAULT_HOLD_INTERVAL = 15
export const DEFAULT_WATCH_INTERVAL = 30
export const MIN_AUTO_INTERVAL = 5
export const MAX_AUTO_INTERVAL = 240
export const AUTO_CONFIG_UPDATED_AT = 'advAuto.configUpdatedAt'
export const AUTO_CONFIG_KEYS = [
  'advAuto.enabled',
  'advAuto.holdEnabled',
  'advAuto.holdIntervalMin',
  'advAuto.watchEnabled',
  'advAuto.watchIntervalMin',
]

function interval(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(MIN_AUTO_INTERVAL, Math.min(MAX_AUTO_INTERVAL, Math.trunc(n)))
}

export function normalizeAutoConfig(input = {}) {
  return {
    enabled: true,
    holdEnabled: input.holdEnabled !== false,
    holdIntervalMin: interval(input.holdIntervalMin, DEFAULT_HOLD_INTERVAL),
    holdLastAt: Number(input.holdLastAt) || 0,
    holdLastTryAt: Number(input.holdLastTryAt) || 0,
    watchEnabled: input.watchEnabled !== false,
    watchIntervalMin: interval(input.watchIntervalMin, DEFAULT_WATCH_INTERVAL),
    watchLastAt: Number(input.watchLastAt) || 0,
    watchLastTryAt: Number(input.watchLastTryAt) || 0,
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
    watchEnabled: has('advAuto.watchEnabled')
      ? settings['advAuto.watchEnabled'] !== false
      : (hasLegacy ? legacyScope !== 'hold' : true),
    watchIntervalMin: has('advAuto.watchIntervalMin')
      ? settings['advAuto.watchIntervalMin']
      : (Number.isFinite(legacyInterval) ? legacyInterval : DEFAULT_WATCH_INTERVAL),
    watchLastAt: settings['advAuto.watchLastAt'] ?? legacyLast,
    watchLastTryAt: settings['advAuto.watchLastTryAt'] ?? legacyLastTry,
  })
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
