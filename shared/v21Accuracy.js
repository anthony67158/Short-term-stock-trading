const CLASS_NAMES = {
  stop: 'STOP_LOSS',
  timeout: 'TIMEOUT',
  take: 'TAKE_PROFIT',
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function actualBarrierClass(entry, path, definition) {
  const takeProfitPct = finite(definition?.takeProfitPct)
  const stopLossPct = finite(definition?.stopLossPct)
  if (
    !Number.isFinite(entry)
    || entry <= 0
    || !path.length
    || takeProfitPct == null
    || stopLossPct == null
  ) return null
  const take = entry * (1 + takeProfitPct / 100)
  const stop = entry * (1 - stopLossPct / 100)
  for (const bar of path) {
    const high = finite(bar?.high)
    const low = finite(bar?.low)
    if (high == null || low == null) return null
    if (low <= stop) return CLASS_NAMES.stop
    if (high >= take) return CLASS_NAMES.take
  }
  return CLASS_NAMES.timeout
}

export function settleV21Prediction(record, bars) {
  if (!record?.asOf || !record?.heads || !Array.isArray(bars)) return null
  const date = String(record.asOf).slice(0, 10)
  const future = bars
    .filter((bar) =>
      String(bar?.tradeTime || '').slice(0, 10) === date
      && String(bar.tradeTime) > String(record.asOf)
    )
    .sort((left, right) =>
      String(left.tradeTime).localeCompare(String(right.tradeTime))
    )
  if (
    future.length < 6
    || !String(future.at(-1)?.tradeTime || '').endsWith('15:00:00')
  ) return null
  const entry = finite(future[0]?.open)
  if (entry == null || entry <= 0) return null
  const paths = {
    next30m: future.slice(0, 6),
    sessionClose: future,
  }
  const heads = {}
  for (const name of ['next30m', 'sessionClose']) {
    const predictedClass = String(record.heads?.[name]?.predictedClass || '')
    const actualClass = actualBarrierClass(
      entry,
      paths[name],
      record.heads?.[name]?.targetDefinition,
    )
    if (!predictedClass || !actualClass) return null
    heads[name] = {
      predictedClass,
      actualClass,
      correct: predictedClass === actualClass,
    }
  }
  return {
    date,
    code: record.code,
    asOf: record.asOf,
    session: record.session,
    entry,
    heads,
  }
}

function summarize(items, accessor) {
  const values = items.map(accessor).filter((value) => value != null)
  const correct = values.filter(Boolean).length
  return {
    total: values.length,
    correct,
    accuracyPct: values.length
      ? +((correct / values.length) * 100).toFixed(2)
      : null,
  }
}

function summarizeGroup(items) {
  return {
    total: items.length,
    heads: {
      next30m: summarize(
        items,
        (item) => item.heads?.next30m?.correct,
      ),
      sessionClose: summarize(
        items,
        (item) => item.heads?.sessionClose?.correct,
      ),
    },
  }
}

export function aggregateV21Accuracy(settled, updatedAt = Date.now()) {
  const items = Array.isArray(settled) ? settled.filter(Boolean) : []
  const sessions = {}
  for (const session of ['morning', 'noon', 'afternoon']) {
    const group = items.filter((item) => item.session === session)
    if (group.length) sessions[session] = summarizeGroup(group)
  }
  const dates = {}
  for (const date of [...new Set(items.map((item) => item.date))].sort()) {
    dates[date] = summarizeGroup(items.filter((item) => item.date === date))
  }
  const overall = summarizeGroup(items)
  return {
    schemaVersion: 1,
    modelVersion: 'v2.1-intraday',
    updatedAt,
    total: items.length,
    heads: overall.heads,
    sessions,
    dates,
  }
}
