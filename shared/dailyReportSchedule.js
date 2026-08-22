import {
  beijingDayKey,
  beijingMinutes,
  isTradingDayAt,
} from './tradingCalendar.js'

export const DAILY_REPORT_SCHEDULE_KEY = 'dailyReport.schedule'
export const DAILY_REPORT_SCHEDULE_WINDOW_MINUTES = 25
export const DAILY_REPORT_MAX_ATTEMPTS = 3
export const DAILY_REPORT_LEASE_MS = 4 * 60 * 1000

export const DEFAULT_DAILY_REPORT_SCHEDULE = Object.freeze({
  enabled: false,
  morning: Object.freeze({ enabled: true, time: '08:30' }),
  noon: Object.freeze({ enabled: true, time: '11:40' }),
  evening: Object.freeze({ enabled: true, time: '15:20' }),
  updatedAt: 0,
})

const SESSION_RULES = Object.freeze({
  morning: {
    label: '盘前日报',
    min: 5 * 60,
    max: 11 * 60 + 20,
    range: '05:00-11:20',
    tradingDayOnly: false,
  },
  noon: {
    label: '午间日报',
    min: 11 * 60 + 30,
    max: 14 * 60 + 55,
    range: '11:30-14:55',
    tradingDayOnly: true,
  },
  evening: {
    label: '收盘日报',
    min: 15 * 60 + 5,
    max: 23 * 60 + 30,
    range: '15:05-23:30',
    tradingDayOnly: true,
  },
})

function timeMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function normalizeSession(value, fallback, key) {
  const rule = SESSION_RULES[key]
  const input = value && typeof value === 'object' ? value : {}
  const time = String(input.time || fallback.time)
  const minutes = timeMinutes(time)
  if (minutes == null || minutes < rule.min || minutes > rule.max) {
    throw new Error(`${rule.label}时间必须在${rule.range}之间`)
  }
  return {
    enabled: typeof input.enabled === 'boolean'
      ? input.enabled
      : fallback.enabled,
    time,
  }
}

export function normalizeDailyReportSchedule(input = {}) {
  return {
    enabled: input.enabled === true,
    morning: normalizeSession(
      input.morning,
      DEFAULT_DAILY_REPORT_SCHEDULE.morning,
      'morning',
    ),
    noon: normalizeSession(
      input.noon,
      DEFAULT_DAILY_REPORT_SCHEDULE.noon,
      'noon',
    ),
    evening: normalizeSession(
      input.evening,
      DEFAULT_DAILY_REPORT_SCHEDULE.evening,
      'evening',
    ),
    updatedAt: Number(input.updatedAt) || 0,
  }
}

export function dailyReportScheduleFromSettings(settings = {}) {
  return normalizeDailyReportSchedule(
    settings?.[DAILY_REPORT_SCHEDULE_KEY] || {},
  )
}

export function withDailyReportSchedule(
  settings = {},
  input = {},
  now = Date.now(),
) {
  return {
    ...settings,
    [DAILY_REPORT_SCHEDULE_KEY]: normalizeDailyReportSchedule({
      ...input,
      updatedAt: Math.max(
        Number(now) || Date.now(),
        Number(settings?.[DAILY_REPORT_SCHEDULE_KEY]?.updatedAt || 0) + 1,
      ),
    }),
  }
}

export function mergeDailyReportScheduleSettings(
  previous = {},
  incoming = {},
) {
  const merged = { ...previous, ...incoming }
  const previousValue = previous?.[DAILY_REPORT_SCHEDULE_KEY]
  const incomingValue = incoming?.[DAILY_REPORT_SCHEDULE_KEY]
  if (
    previousValue
    && (
      !incomingValue
      || Number(previousValue.updatedAt) > Number(incomingValue.updatedAt)
    )
  ) {
    merged[DAILY_REPORT_SCHEDULE_KEY] = previousValue
  }
  return merged
}

export function newerDailyReportSchedulePatch(
  previous = {},
  incoming = {},
) {
  const previousValue = previous?.[DAILY_REPORT_SCHEDULE_KEY]
  const incomingValue = incoming?.[DAILY_REPORT_SCHEDULE_KEY]
  if (
    !incomingValue
    || Number(incomingValue.updatedAt) <= Number(previousValue?.updatedAt)
  ) return null
  return {
    [DAILY_REPORT_SCHEDULE_KEY]:
      normalizeDailyReportSchedule(incomingValue),
  }
}

function compactMap(value, limit = 45) {
  return Object.fromEntries(
    Object.entries(
      value && typeof value === 'object' ? value : {},
    )
      .sort((left, right) => Number(right[1]?.at || right[1])
        - Number(left[1]?.at || left[1]))
      .slice(0, limit),
  )
}

function runKey(day, session) {
  return `${day}:${session}`
}

function currentAttempt(state, key) {
  const recorded = state?.attempts?.[key]
  return Math.max(
    Number(recorded?.count ?? recorded) || 0,
    state?.active?.runKey === key
      ? Number(state.active.attempt) || 0
      : 0,
  )
}

export function claimDueDailyReport(data, {
  now = Date.now(),
  windowMinutes = DAILY_REPORT_SCHEDULE_WINDOW_MINUTES,
  leaseMs = DAILY_REPORT_LEASE_MS,
} = {}) {
  const schedule = dailyReportScheduleFromSettings(data?.settings || {})
  if (!schedule.enabled) return null
  const timestamp = Number(now) || Date.now()
  const state = data.dailyReportAuto || {}
  if (
    state.active?.status === 'running'
    && Number(state.active.leaseUntil) > timestamp
  ) return null

  const day = beijingDayKey(timestamp)
  const minutes = beijingMinutes(timestamp)
  const tradingDay = isTradingDayAt(timestamp)
  const completed = state.completed || {}
  const attempts = state.attempts || {}
  const due = ['morning', 'noon', 'evening'].find((session) => {
    const sessionConfig = schedule[session]
    const rule = SESSION_RULES[session]
    if (
      !sessionConfig.enabled
      || (rule.tradingDayOnly && !tradingDay)
    ) return false
    const target = timeMinutes(sessionConfig.time)
    const key = runKey(day, session)
    return minutes >= target
      && minutes <= target + Math.max(5, Number(windowMinutes) || 25)
      && !completed[key]
      && currentAttempt(state, key) < DAILY_REPORT_MAX_ATTEMPTS
  })
  if (!due) {
    if (data.dailyReportAuto?.active) {
      data.dailyReportAuto = {
        ...state,
        active: null,
        updatedAt: timestamp,
      }
    }
    return null
  }

  const key = runKey(day, due)
  const attempt = currentAttempt(state, key) + 1
  const claim = {
    runKey: key,
    day,
    session: due,
    attempt,
    status: 'running',
    startedAt: timestamp,
    leaseUntil: timestamp + Math.max(60_000, Number(leaseMs) || DAILY_REPORT_LEASE_MS),
  }
  data.dailyReportAuto = {
    ...state,
    active: claim,
    attempts: compactMap({
      ...attempts,
      [key]: { count: attempt, at: timestamp },
    }),
    updatedAt: timestamp,
  }
  return claim
}

function sameRun(state, run) {
  return !!(
    state?.active
    && state.active.runKey === run.runKey
    && state.active.session === run.session
  )
}

export function completeDailyReportRun(data, {
  runKey: key,
  session,
  summary = null,
  now = Date.now(),
} = {}) {
  const timestamp = Number(now) || Date.now()
  const state = data.dailyReportAuto || {}
  if (!key || !sameRun(state, { runKey: key, session })) return false
  data.dailyReportAuto = {
    ...state,
    active: null,
    completed: compactMap({
      ...(state.completed || {}),
      [key]: timestamp,
    }),
    latest: {
      runKey: key,
      session,
      status: 'done',
      finishedAt: timestamp,
      summary,
    },
    updatedAt: timestamp,
  }
  return true
}

export function failDailyReportRun(data, {
  runKey: key,
  session,
  error,
  now = Date.now(),
} = {}) {
  const timestamp = Number(now) || Date.now()
  const state = data.dailyReportAuto || {}
  if (!key || !sameRun(state, { runKey: key, session })) return false
  data.dailyReportAuto = {
    ...state,
    active: null,
    latest: {
      runKey: key,
      session,
      status: 'failed',
      finishedAt: timestamp,
      error: String(error || '日报生成失败').slice(0, 240),
    },
    updatedAt: timestamp,
  }
  return true
}
