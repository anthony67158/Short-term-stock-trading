import { createHash } from 'node:crypto'

export const LEARNING_EVENT_SCHEMA_VERSION = 'learning-event.v1'
export const LEARNING_PREFIX = 'learning/v1/'

export const LEARNING_EVENT_KIND = Object.freeze({
  STOCK_PICK_PREDICTION: 'stock-pick-prediction',
  POSITION_PREDICTION: 'position-prediction',
  EXECUTION: 'execution',
  OUTCOME: 'outcome',
  MARKET: 'market',
})

const KINDS = new Set(Object.values(LEARNING_EVENT_KIND))

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  )
}

export function stableJson(value) {
  return JSON.stringify(canonical(value))
}

export function learningContentHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function learningAccountHash(scope) {
  const value = String(scope || '').trim()
  if (!value) return 'global'
  return createHash('sha256')
    .update(`learning:v1:${value}`)
    .digest('hex')
    .slice(0, 32)
}

function safeSegment(value, label, pattern = /^[a-zA-Z0-9._:-]+$/) {
  const text = String(value || '').trim()
  if (!text || text.length > 180 || !pattern.test(text)) {
    throw new Error(`学习事件${label}无效`)
  }
  return text
}

function safeTradeDate(value) {
  return safeSegment(
    value,
    '交易日期',
    /^\d{4}-\d{2}-\d{2}$/,
  )
}

export function buildLearningEvent({
  kind,
  eventId,
  sourceId,
  tradeDate,
  accountScope = '',
  occurredAt = Date.now(),
  payload = {},
  lineage = {},
} = {}) {
  const normalizedKind = safeSegment(kind, '类型')
  if (!KINDS.has(normalizedKind)) throw new Error('学习事件类型无效')
  const normalizedSourceId = safeSegment(sourceId, '来源ID')
  const normalizedEventId = safeSegment(
    eventId || `${normalizedKind}:${normalizedSourceId}`,
    'ID',
  )
  const timestamp = Number(occurredAt)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error('学习事件时间无效')
  }
  const base = {
    schemaVersion: LEARNING_EVENT_SCHEMA_VERSION,
    kind: normalizedKind,
    eventId: normalizedEventId,
    sourceId: normalizedSourceId,
    tradeDate: safeTradeDate(tradeDate),
    accountHash: learningAccountHash(accountScope),
    occurredAt: Math.trunc(timestamp),
    payload: canonical(payload),
    lineage: canonical(lineage),
  }
  return {
    ...base,
    contentHash: learningContentHash(base),
  }
}

export function learningEventPath(event) {
  if (event?.schemaVersion !== LEARNING_EVENT_SCHEMA_VERSION) {
    throw new Error('学习事件版本无效')
  }
  const kind = safeSegment(event.kind, '类型')
  const tradeDate = safeTradeDate(event.tradeDate)
  const accountHash = safeSegment(event.accountHash, '账户哈希')
  const eventIdHash = createHash('sha256')
    .update(String(event.eventId || ''))
    .digest('hex')
    .slice(0, 32)
  return `${LEARNING_PREFIX}${kind}/${tradeDate}/`
    + `${accountHash}/${eventIdHash}.json`
}
