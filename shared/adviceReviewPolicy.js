import {
  ADVICE_REVIEW_DISABLED_CODES,
  AUTO_CONFIG_UPDATED_AT,
} from './adviceAutoRefreshPolicy.js'

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000

const A_SHARE_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  '2026-04-06',
  '2026-05-01',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01',
  '2026-10-02',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
])

const DEFAULT_INTERVALS = {
  hold_advice: 15,
  buy_advice: 30,
}

function bjParts(timestamp) {
  const date = new Date(timestamp + BJ_OFFSET_MS)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
  }
}

function dayKey(parts) {
  return `${parts.year}-${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function isTradeDay(timestamp) {
  const parts = bjParts(timestamp)
  return parts.weekday >= 1
    && parts.weekday <= 5
    && !A_SHARE_HOLIDAYS.has(dayKey(parts))
}

function atBjMinutes(timestamp, minutes) {
  const parts = bjParts(timestamp)
  return Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    Math.floor(minutes / 60),
    minutes % 60,
  ) - BJ_OFFSET_MS
}

function nextTradeOpen(timestamp) {
  let cursor = atBjMinutes(timestamp, 570) + 24 * 60 * 60 * 1000
  for (let index = 0; index < 14; index++) {
    if (isTradeDay(cursor)) return cursor
    cursor += 24 * 60 * 60 * 1000
  }
  return cursor
}

function alignToTradingSession(timestamp) {
  if (!isTradeDay(timestamp)) return nextTradeOpen(timestamp)
  const parts = bjParts(timestamp)
  if (parts.minutes < 570) return atBjMinutes(timestamp, 570)
  if (parts.minutes <= 690) return timestamp
  if (parts.minutes < 780) return atBjMinutes(timestamp, 780)
  if (parts.minutes <= 900) return timestamp
  return nextTradeOpen(timestamp)
}

export function nextAdviceReviewAt({
  now = Date.now(),
  mode = 'buy_advice',
  intervalMin,
} = {}) {
  const fallback = DEFAULT_INTERVALS[mode] || DEFAULT_INTERVALS.buy_advice
  const parsed = Number(intervalMin)
  const minutes = Number.isFinite(parsed)
    ? Math.max(5, Math.min(240, Math.trunc(parsed)))
    : fallback
  const candidate = alignToTradingSession(Number(now) || Date.now())
    + minutes * 60 * 1000
  return alignToTradingSession(candidate)
}

export function buildAdviceReviewCycle(previous, data, at = Date.now()) {
  const advice = data?.advice && typeof data.advice === 'object'
    ? data.advice
    : null
  const mode = data?.mode || previous?.mode || 'buy_advice'
  const priorCycle = previous?.advice?.reviewCycle || {}
  const previousAction = previous?.advice?.action
    || previous?.advice?.stance
    || ''
  return {
    status: data?.reviewDisposition || 'scheduled',
    sequence: Math.max(0, Number(priorCycle.sequence) || 0) + 1,
    reviewedAt: at,
    nextReviewAt: nextAdviceReviewAt({
      now: at,
      mode,
      intervalMin: data?.reviewIntervalMin,
    }),
    intervalMin: Number(data?.reviewIntervalMin)
      || DEFAULT_INTERVALS[mode]
      || DEFAULT_INTERVALS.buy_advice,
    trigger: data?.reviewTrigger || (previous ? 'scheduled' : 'initial'),
    reason: String(data?.reviewReason || '').slice(0, 160),
    previousAction,
    changeType: ['unchanged', 'insufficient'].includes(data?.reviewDisposition)
      ? 'maintain'
      : advice
      ? advice.continuity?.changeType || (previous ? 'maintain' : 'initial')
      : 'unavailable',
  }
}

export function adviceReviewDue(entry, now = Date.now()) {
  const nextReviewAt = Number(
    entry?.reviewCycle?.nextReviewAt
      ?? entry?.advice?.reviewCycle?.nextReviewAt,
  )
  return !Number.isFinite(nextReviewAt) || nextReviewAt <= now
}

function reviewCode(value) {
  const code = String(value || '').trim()
  return /^\d{6}$/.test(code) ? code : ''
}

export function disabledAdviceReviewCodes(settings = {}) {
  const values = Array.isArray(settings?.[ADVICE_REVIEW_DISABLED_CODES])
    ? settings[ADVICE_REVIEW_DISABLED_CODES]
    : []
  return [...new Set(values.map(reviewCode).filter(Boolean))].slice(0, 500)
}

export function isAdviceReviewEnabled(settings = {}, code) {
  const normalized = reviewCode(code)
  if (!normalized) return true
  return !disabledAdviceReviewCodes(settings).includes(normalized)
}

export function setAdviceReviewEnabled(
  settings = {},
  code,
  enabled,
  now = Date.now(),
) {
  const normalized = reviewCode(code)
  if (!normalized) return { ...settings }
  const disabled = new Set(disabledAdviceReviewCodes(settings))
  if (enabled) disabled.delete(normalized)
  else disabled.add(normalized)
  return {
    ...settings,
    [ADVICE_REVIEW_DISABLED_CODES]: [...disabled].sort(),
    [AUTO_CONFIG_UPDATED_AT]: now,
  }
}
