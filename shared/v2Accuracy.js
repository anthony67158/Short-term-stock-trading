const CLASSES = new Set(['STOP_LOSS', 'TIMEOUT', 'TAKE_PROFIT'])

export function nextTradingSession(bars, signalDate) {
  const dates = [...new Set(
    (bars || [])
      .map((item) => String(item?.tradeTime || '').slice(0, 10))
      .filter((date) => date > signalDate),
  )].sort()
  if (!dates.length) return []
  return (bars || []).filter(
    (item) => String(item?.tradeTime || '').startsWith(dates[0]),
  )
}

export function actualBarrierClass(session, {
  takeProfitPct = 0.01,
  stopLossPct = 0.006,
} = {}) {
  if (!Array.isArray(session) || !session.length) return null
  const entry = Number(session[0]?.open)
  if (!(entry > 0)) return null
  const upper = entry * (1 + takeProfitPct)
  const lower = entry * (1 - stopLossPct)
  for (const item of session) {
    const high = Number(item?.high)
    const low = Number(item?.low)
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null
    const hitProfit = high >= upper
    const hitLoss = low <= lower
    if (hitLoss) return 'STOP_LOSS'
    if (hitProfit) return 'TAKE_PROFIT'
  }
  return 'TIMEOUT'
}

export function aggregateV2Accuracy(predictions) {
  const latest = new Map()
  for (const item of predictions || []) {
    if (!item || /smoke/i.test(String(item.requestId || ''))) continue
    if (
      !CLASSES.has(item.predictedClass) ||
      !CLASSES.has(item.actualClass)
    ) continue
    const date = String(item.asOf || '').slice(0, 10)
    const code = String(item.code || '')
    if (!/^\d{6}\.(?:SH|SZ)$/.test(code) || !date) continue
    const key = `${date}:${code}`
    const current = latest.get(key)
    if (!current || (Number(item.recordedAt) || 0) >= (Number(current.recordedAt) || 0)) {
      latest.set(key, item)
    }
  }
  const byDate = new Map()
  for (const item of latest.values()) {
    const date = String(item.asOf).slice(0, 10)
    const group = byDate.get(date) || { date, total: 0, correct: 0 }
    group.total++
    if (item.predictedClass === item.actualClass) group.correct++
    byDate.set(date, group)
  }
  const days = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((item) => ({
      ...item,
      accuracyPct: item.total ? +(item.correct / item.total * 100).toFixed(1) : null,
    }))
  const total = days.reduce((sum, item) => sum + item.total, 0)
  const correct = days.reduce((sum, item) => sum + item.correct, 0)
  return {
    updatedAt: Date.now(),
    overall: {
      total,
      correct,
      accuracyPct: total ? +(correct / total * 100).toFixed(1) : null,
    },
    days,
  }
}

export function mergeV2Accuracy(existing, fresh, updatedAt = Date.now()) {
  const byDate = new Map()
  for (const item of existing?.days || []) {
    if (item?.date) byDate.set(String(item.date), item)
  }
  for (const item of fresh?.days || []) {
    if (item?.date) byDate.set(String(item.date), item)
  }
  const days = [...byDate.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((item) => ({
      date: String(item.date),
      total: Number(item.total) || 0,
      correct: Number(item.correct) || 0,
      accuracyPct: Number(item.total)
        ? +(Number(item.correct) / Number(item.total) * 100).toFixed(1)
        : null,
    }))
  const total = days.reduce((sum, item) => sum + item.total, 0)
  const correct = days.reduce((sum, item) => sum + item.correct, 0)
  return {
    updatedAt,
    overall: {
      total,
      correct,
      accuracyPct: total ? +(correct / total * 100).toFixed(1) : null,
    },
    days,
  }
}
