const LABELS = Object.freeze({
  PRE_CATALYST: '预催化发现',
  TAIL: '尾盘反转',
  INTRADAY: '盘中公式',
  NEXT_SESSION: '次日计划',
  UNRECORDED: '来源未记录',
})

function text(value, limit = 180) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, limit)
}

function number(value) {
  if (value == null || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) && result > 0 ? result : null
}

function list(value, limit = 4) {
  return (Array.isArray(value) ? value : []).map((item) => text(item)).filter(Boolean).slice(0, limit)
}

function httpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href.slice(0, 500) : ''
  } catch { return '' }
}

export function normalizeSelectionOrigin(value) {
  if (value?.schemaVersion !== 'selection-origin.v1'
    || !/^\d{6}$/.test(String(value.code || ''))
    || !number(value.capturedAt)) return null
  const sourceType = Object.hasOwn(LABELS, value.sourceType)
    ? value.sourceType : 'UNRECORDED'
  return {
    schemaVersion: 'selection-origin.v1',
    code: String(value.code),
    sourceType,
    label: LABELS[sourceType],
    capturedAt: number(value.capturedAt),
    evidenceAsOf: number(value.evidenceAsOf),
    eventId: text(value.eventId, 100),
    sourceUrl: httpsUrl(value.sourceUrl),
    reasons: list(value.reasons),
    risks: list(value.risks),
    industry: text(value.industry, 60),
    concepts: list(value.concepts, 6),
    entry: {
      price: number(value.entry?.price),
      trigger: text(value.entry?.trigger),
      window: text(value.entry?.window, 80),
      validUntil: number(value.entry?.validUntil),
    },
    exit: {
      stopPrice: number(value.exit?.stopPrice),
      targetPrice: number(value.exit?.targetPrice),
      timeStopDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value.exit?.timeStopDate))
        ? value.exit.timeStopDate : '',
      rule: text(value.exit?.rule),
    },
  }
}

export function selectionOriginFromOpportunity(row, snapshot = {}, now = Date.now()) {
  const sourceType = row.origin === 'PRE_CATALYST' ? 'PRE_CATALYST'
    : row.origin === 'TAIL' ? 'TAIL'
      : row.lane === 'next' ? 'NEXT_SESSION' : 'INTRADAY'
  return normalizeSelectionOrigin({
    schemaVersion: 'selection-origin.v1',
    code: row.code,
    sourceType,
    capturedAt: now,
    evidenceAsOf: row.discoveredAt || snapshot.generatedAt,
    eventId: row.event?.eventId || '',
    sourceUrl: row.event?.sourceUrl,
    reasons: row.evidence,
    risks: row.blockers,
    industry: row.tags?.industry,
    concepts: row.tags?.concepts,
    entry: row.entryPlan,
    exit: {
      stopPrice: row.exitPlan?.hardStopPrice,
      targetPrice: row.exitPlan?.takeProfitPrice,
      timeStopDate: row.exitPlan?.timeStopDate,
      rule: row.exitPlan?.rule,
    },
  })
}

export function selectionSourcePerformance(records = []) {
  const seen = new Set()
  const groups = new Map()
  for (const trade of records) {
    if (!trade?.id || seen.has(trade.id)) continue
    seen.add(trade.id)
    if ((trade.type || trade.kind) !== 'SELL' || trade.tradeIntent === 't') continue
    const pnl = trade.netPnl ?? trade.realizedPnl
    if (pnl == null || pnl === '' || !Number.isFinite(Number(pnl))) continue
    const origin = normalizeSelectionOrigin(trade.selectionOrigin)
    const key = origin?.sourceType || 'UNRECORDED'
    const group = groups.get(key) || {
      sourceType: key, label: LABELS[key], sales: 0,
      netPnl: 0, fees: 0, positions: new Set(),
    }
    group.sales++
    group.netPnl += Number(pnl)
    group.fees += Math.max(0, Number(trade.buyFee) || 0)
      + Math.max(0, Number(trade.sellFee ?? trade.fee) || 0)
    group.positions.add(trade.holdingId || trade.id)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    ...group,
    positions: group.positions.size,
    netPnl: +group.netPnl.toFixed(2),
    fees: +group.fees.toFixed(2),
    averagePerSale: +(group.netPnl / group.sales).toFixed(2),
  })).sort((a, b) => b.sales - a.sales || a.sourceType.localeCompare(b.sourceType))
}
