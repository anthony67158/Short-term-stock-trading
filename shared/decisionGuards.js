export function computeSellAllowance(requestedQty, sellableToday) {
  const requested = Number(requestedQty)
  const sellable = Number(sellableToday)
  const safeRequested = Number.isFinite(requested) && requested > 0 ? requested : 0
  const safeSellable = Number.isFinite(sellable) && sellable > 0 ? sellable : 0
  const allowed = Math.min(safeRequested, safeSellable)
  return {
    ok: allowed > 0,
    requested: safeRequested,
    allowed,
    adjusted: allowed > 0 && allowed < safeRequested,
  }
}

export function normalizeConfidence(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, n))
}

export function isConfirmationPhase(phase) {
  return phase === '早盘(盘中)' || phase === '午盘(盘中)'
}

function parseMinuteStamp(value, fallbackDate = '') {
  const s = String(value || '').trim()
  const match = s.match(/^(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{2}):(\d{2})/)
  if (!match) return null
  const hour = Number(match[2])
  const minute = Number(match[3])
  if (hour > 23 || minute > 59) return null
  return {
    date: match[1] || fallbackDate,
    minuteOfDay: hour * 60 + minute,
  }
}

export function isMinuteSnapshotFresh(lastTime, bjNow, maxAgeMinutes = 3) {
  const current = parseMinuteStamp(bjNow)
  if (!current || !current.date) return false
  const latest = parseMinuteStamp(lastTime, current.date)
  if (!latest || latest.date !== current.date) return false
  const age = current.minuteOfDay - latest.minuteOfDay
  return age >= 0 && age <= maxAgeMinutes
}
