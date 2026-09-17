export const STOCK_PICK_MODE = Object.freeze({
  INTRADAY: 'INTRADAY',
  EARLY_LAYOUT: 'EARLY_LAYOUT',
  NEXT_DAY: 'NEXT_DAY',
})

export const STOCK_PICK_MODES = Object.freeze([
  Object.freeze({
    id: STOCK_PICK_MODE.INTRADAY,
    label: '盘中机会',
    description: '寻找当日仍具备可执行买点的候选，买入后严格按 T+1 管理。',
  }),
  Object.freeze({
    id: STOCK_PICK_MODE.EARLY_LAYOUT,
    label: '提前布局',
    description: '寻找趋势尚未充分启动、适合小仓提前观察和等待确认的候选。',
  }),
  Object.freeze({
    id: STOCK_PICK_MODE.NEXT_DAY,
    label: '次日关注',
    description: '收盘后结合收盘价、资金和公告形成次日重点观察清单。',
  }),
])

export const NEXT_DAY_SELECTION_SCHEMA = 'stock-pick-next-day-selection.v1'
export const STOCK_PICK_TRACE_SCHEMA = 'stock-pick-agent-trace.v1'
export const STOCK_PICK_NEXT_DAY_MAX = 12

const MODE_SET = new Set(STOCK_PICK_MODES.map((item) => item.id))

function text(value, maximum = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function normalizeStockPickMode(value) {
  const mode = String(value || '').trim().toUpperCase()
  return MODE_SET.has(mode) ? mode : STOCK_PICK_MODE.INTRADAY
}

export function stockPickModeMeta(value) {
  const mode = normalizeStockPickMode(value)
  return STOCK_PICK_MODES.find((item) => item.id === mode)
    || STOCK_PICK_MODES[0]
}

export function candidateSubset(snapshot = {}, codes = []) {
  const requested = new Set(
    (Array.isArray(codes) ? codes : [])
      .map((code) => String(code || '').trim())
      .filter((code) => /^\d{6}$/.test(code)),
  )
  const candidates = Array.isArray(snapshot?.candidates)
    ? snapshot.candidates
    : []
  if (!requested.size) return candidates
  return candidates.filter((item) => requested.has(String(item?.code || '')))
}

export function normalizeNextDaySelection({
  codes = [],
  snapshot = {},
  previous = null,
  now = Date.now(),
} = {}) {
  const allowed = new Map(
    (Array.isArray(snapshot?.candidates) ? snapshot.candidates : [])
      .filter((item) => /^\d{6}$/.test(String(item?.code || '')))
      .map((item) => [String(item.code), item]),
  )
  const seen = new Set()
  const items = []
  for (const rawCode of Array.isArray(codes) ? codes : []) {
    const code = String(rawCode || '').trim()
    const candidate = allowed.get(code)
    if (!candidate || seen.has(code)) continue
    seen.add(code)
    items.push({
      code,
      name: text(candidate.name, 60),
      rankingSource: text(candidate.ranking?.source, 20),
      rankingScore: finite(candidate.ranking?.score),
    })
    if (items.length >= STOCK_PICK_NEXT_DAY_MAX) break
  }
  const priorAuto = previous?.autoRecalculatedTradeDate
    ? text(previous.autoRecalculatedTradeDate, 16)
    : ''
  return {
    schemaVersion: NEXT_DAY_SELECTION_SCHEMA,
    sourceTradeDate: text(snapshot?.tradeDate, 16),
    items,
    savedAt: finite(now) || Date.now(),
    autoRecalculatedTradeDate: priorAuto,
  }
}

export function firstQuoteRecalculationCodes(
  selection = {},
  quotes = [],
) {
  const sourceTradeDate = text(selection?.sourceTradeDate, 16)
  const alreadyDone = text(selection?.autoRecalculatedTradeDate, 16)
  const selected = new Set(
    (Array.isArray(selection?.items) ? selection.items : [])
      .map((item) => String(item?.code || ''))
      .filter((code) => /^\d{6}$/.test(code)),
  )
  if (!selected.size) return []
  return (Array.isArray(quotes) ? quotes : [])
    .filter((quote) => {
      const code = String(quote?.code || '')
      const tradeDate = text(quote?.tradeDate, 16)
      return selected.has(code)
        && quote?.isLivePrice === true
        && Number(quote?.price) > 0
        && !!tradeDate
        && tradeDate !== sourceTradeDate
        && tradeDate !== alreadyDone
    })
    .map((quote) => String(quote.code))
}

export function createStockPickTrace({
  mode,
  runId = '',
  trigger = 'MANUAL',
  now = Date.now(),
} = {}) {
  const startedAt = finite(now) || Date.now()
  return {
    schemaVersion: STOCK_PICK_TRACE_SCHEMA,
    mode: normalizeStockPickMode(mode),
    runId: text(runId, 80),
    trigger: text(trigger, 40) || 'MANUAL',
    status: 'RUNNING',
    currentStage: 'PREPARE',
    percent: 4,
    events: [],
    startedAt,
    updatedAt: startedAt,
  }
}

export function appendStockPickTrace(trace = {}, event = {}, now = Date.now()) {
  const timestamp = finite(now) || Date.now()
  const nextEvent = {
    id: text(event.id, 80) || `event-${timestamp}`,
    type: text(event.type, 24) || 'stage',
    status: text(event.status, 24) || 'done',
    label: text(event.label, 80),
    detail: text(event.detail, 240),
    tool: text(event.tool, 60),
    at: timestamp,
  }
  const events = [
    ...(Array.isArray(trace?.events) ? trace.events : []),
    nextEvent,
  ].slice(-40)
  return {
    ...trace,
    status: text(event.runStatus, 20) || trace.status || 'RUNNING',
    currentStage: text(event.stage, 40) || trace.currentStage || 'PREPARE',
    percent: Math.max(
      0,
      Math.min(100, finite(event.percent) ?? finite(trace.percent) ?? 0),
    ),
    events,
    updatedAt: timestamp,
    ...(event.runStatus === 'DONE' || event.runStatus === 'FAILED'
      ? { finishedAt: timestamp }
      : {}),
  }
}
