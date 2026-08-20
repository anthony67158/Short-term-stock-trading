import {
  beijingDayKey,
  beijingMinutes,
  isTradingDayAt,
} from '../shared/tradingCalendar.js'
import {
  del,
  hasStorage,
  list,
  put,
  readJson,
} from './_blob.js'

export const SECTOR_FORECAST_PREFIX = 'market/sector-forecast/'
export const DEFAULT_SECTOR_FORECAST_SETTINGS = Object.freeze({
  autoEnabled: true,
  closeTime: '15:10',
  overnightEnabled: true,
  overnightTime: '08:50',
})

const PATHS = Object.freeze({
  latest: `${SECTOR_FORECAST_PREFIX}latest.json`,
  settings: `${SECTOR_FORECAST_PREFIX}settings.json`,
  task: `${SECTOR_FORECAST_PREFIX}task.json`,
  history: `${SECTOR_FORECAST_PREFIX}history/`,
  outcomes: `${SECTOR_FORECAST_PREFIX}outcomes/`,
  locks: `${SECTOR_FORECAST_PREFIX}locks/`,
})

function timeMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function normalizedTime(value, fallback, range, label) {
  const resolved = value == null || value === ''
    ? fallback
    : String(value)
  const minutes = timeMinutes(resolved)
  if (minutes === null || minutes < range[0] || minutes > range[1]) {
    throw new Error(`${label}必须在${range[2]}之间`)
  }
  return resolved
}

export function normalizeSectorForecastSettings(input = {}) {
  return {
    autoEnabled: typeof input.autoEnabled === 'boolean'
      ? input.autoEnabled
      : DEFAULT_SECTOR_FORECAST_SETTINGS.autoEnabled,
    closeTime: normalizedTime(
      input.closeTime,
      DEFAULT_SECTOR_FORECAST_SETTINGS.closeTime,
      [15 * 60 + 5, 23 * 60 + 59, '15:05-23:59'],
      '收盘任务时间',
    ),
    overnightEnabled: typeof input.overnightEnabled === 'boolean'
      ? input.overnightEnabled
      : DEFAULT_SECTOR_FORECAST_SETTINGS.overnightEnabled,
    overnightTime: normalizedTime(
      input.overnightTime,
      DEFAULT_SECTOR_FORECAST_SETTINGS.overnightTime,
      [6 * 60, 9 * 60 + 25, '06:00-09:25'],
      '盘前任务时间',
    ),
  }
}

export function sectorForecastRunKey(signalDate, session) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(signalDate || ''))
    ? String(signalDate)
    : ''
  const runSession = session === 'overnight' ? 'overnight' : 'close'
  return day ? `${day}:${runSession}` : ''
}

export function dueSectorForecastSession(
  timestamp = Date.now(),
  settings = DEFAULT_SECTOR_FORECAST_SETTINGS,
  task = {},
) {
  if (!isTradingDayAt(timestamp)) return null
  const normalized = normalizeSectorForecastSettings(settings)
  const day = beijingDayKey(timestamp)
  const minutes = beijingMinutes(timestamp)
  const completed = task?.completed || {}
  const overnightKey = sectorForecastRunKey(day, 'overnight')
  if (
    normalized.overnightEnabled
    && minutes >= timeMinutes(normalized.overnightTime)
    && minutes <= 9 * 60 + 25
    && !completed[overnightKey]
  ) return 'overnight'
  const closeKey = sectorForecastRunKey(day, 'close')
  if (
    normalized.autoEnabled
    && minutes >= timeMinutes(normalized.closeTime)
    && !completed[closeKey]
  ) return 'close'
  return null
}

function jsonOptions() {
  return {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  }
}

function snapshotPath(snapshot) {
  const day = String(snapshot?.signalDate || '')
  const session = snapshot?.session === 'overnight' ? 'overnight' : 'close'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('板块前瞻快照缺少有效signalDate')
  }
  return `${PATHS.history}${day}/${session}.json`
}

function historySummary(snapshot) {
  return {
    signalDate: String(snapshot?.signalDate || ''),
    session: snapshot?.session === 'overnight' ? 'overnight' : 'close',
    generatedAt: Number(snapshot?.generatedAt) || 0,
    sectorCount: Array.isArray(snapshot?.sectors)
      ? snapshot.sectors.length
      : 0,
  }
}

export function createSectorForecastStore(storage = {
  del,
  hasStorage,
  list,
  put,
  readJson,
}) {
  const ensureStorage = () => {
    if (!storage.hasStorage()) {
      throw new Error('存储未配置(OSS)，无法保存板块前瞻')
    }
  }
  const writeJson = async (path, value) => {
    ensureStorage()
    await storage.put(path, JSON.stringify(value), jsonOptions())
    return value
  }
  return {
    paths: PATHS,
    async readSettings() {
      const stored = storage.hasStorage()
        ? await storage.readJson(PATHS.settings).catch(() => null)
        : null
      return normalizeSectorForecastSettings(stored || {})
    },
    async saveSettings(patch = {}, now = Date.now()) {
      const current = await this.readSettings()
      const next = normalizeSectorForecastSettings({
        ...current,
        ...patch,
      })
      await writeJson(PATHS.settings, {
        ...next,
        updatedAt: Number(now) || Date.now(),
      })
      return next
    },
    async readLatest() {
      if (!storage.hasStorage()) return null
      return storage.readJson(PATHS.latest).catch(() => null)
    },
    async saveSnapshot(snapshot) {
      await writeJson(snapshotPath(snapshot), snapshot)
      await writeJson(PATHS.latest, snapshot)
      return snapshot
    },
    async readHistory(limit = 20) {
      if (!storage.hasStorage()) return []
      const max = Math.max(1, Math.min(120, Number(limit) || 20))
      const { blobs } = await storage.list({
        prefix: PATHS.history,
        limit: 500,
      })
      const snapshots = await Promise.all(
        (blobs || []).map((blob) =>
          storage.readJson(blob?.pathname || blob).catch(() => null)
        ),
      )
      return snapshots
        .filter((item) => item?.signalDate)
        .sort((left, right) =>
          Number(right.generatedAt || 0) - Number(left.generatedAt || 0)
          || String(right.signalDate).localeCompare(String(left.signalDate))
        )
        .slice(0, max)
        .map(historySummary)
    },
    async readHistorySnapshot(signalDate, session = 'close') {
      if (!storage.hasStorage()) return null
      return storage.readJson(snapshotPath({ signalDate, session }))
        .catch(() => null)
    },
    async readTask() {
      if (!storage.hasStorage()) return { completed: {} }
      const task = await storage.readJson(PATHS.task).catch(() => null)
      return {
        ...(task && typeof task === 'object' ? task : {}),
        completed: task?.completed && typeof task.completed === 'object'
          ? task.completed
          : {},
      }
    },
    async saveTask(task) {
      return writeJson(PATHS.task, {
        ...task,
        completed: task?.completed && typeof task.completed === 'object'
          ? task.completed
          : {},
      })
    },
    async claimRun(runKey, now = Date.now()) {
      ensureStorage()
      const safeKey = String(runKey || '')
        .replace(/[^0-9A-Za-z:_-]/g, '')
        .replaceAll(':', '-')
      if (!safeKey) throw new Error('板块前瞻任务锁键无效')
      const bucket = Math.floor((Number(now) || Date.now()) / 900000)
      const path = `${PATHS.locks}${safeKey}-${bucket}.json`
      try {
        await storage.put(path, JSON.stringify({
          runKey: String(runKey),
          claimedAt: Number(now) || Date.now(),
        }), {
          ...jsonOptions(),
          forbidOverwrite: true,
        })
        return { acquired: true, path }
      } catch (error) {
        if (
          error?.status === 409
          || [
            'FileAlreadyExists',
            'ObjectAlreadyExists',
            'PositionNotEqualToLength',
          ].includes(error?.code)
        ) return { acquired: false, path }
        throw error
      }
    },
    async releaseRun(claim) {
      const path = String(claim?.path || '')
      if (
        claim?.acquired !== true
        || !path.startsWith(PATHS.locks)
        || typeof storage.del !== 'function'
      ) return false
      await storage.del(path)
      return true
    },
    async saveOutcomes(signalDate, outcomes) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(signalDate || ''))) {
        throw new Error('板块前瞻结算日期无效')
      }
      return writeJson(
        `${PATHS.outcomes}${signalDate}.json`,
        outcomes,
      )
    },
  }
}

export const sectorForecastStore = createSectorForecastStore()
