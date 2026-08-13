export const EVIDENCE_SCHEMA_VERSION = 'canonical-evidence.v1'
export const EVIDENCE_COLLECTOR_VERSION = 'ai-collector.v1'
export const EVIDENCE_SNAPSHOT_LIMIT = 80

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function compact(value, depth = 0) {
  if (value == null) return null
  if (depth > 4) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.slice(0, 300)
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compact(item, depth + 1))
  }
  if (typeof value !== 'object') return null
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, compact(item, depth + 1)])
      .filter(([, item]) => item != null),
  )
}

function hashText(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function sourceTextVersion(prefix, text) {
  return `${String(prefix || 'source')}.${hashText(String(text || ''))}`
}

function source(available, state, dataAsOf, observedAt) {
  return {
    available: !!available,
    state: available ? state : 'MISSING',
    dataAsOf: dataAsOf || null,
    observedAt,
  }
}

function isoTime(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function safeErrorCode(error) {
  const name = String(error?.name || 'Error')
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : 'Error'
}

export function createEvidenceSourceTracker({
  clock = Date.now,
} = {}) {
  const records = []
  return {
    async track(key, label, promise, {
      isAvailable = (value) => value != null,
      dataAsOf = () => null,
    } = {}) {
      const startedAt = Number(clock())
      try {
        const value = await promise
        const finishedAt = Number(clock())
        const available = !!isAvailable(value)
        records.push({
          key: String(key),
          label: String(label),
          status: available ? 'OK' : 'EMPTY',
          startedAt: isoTime(startedAt),
          finishedAt: isoTime(finishedAt),
          durationMs: Math.max(0, finishedAt - startedAt),
          dataAsOf: available ? (dataAsOf(value) || null) : null,
          errorCode: null,
        })
        return value
      } catch (error) {
        const finishedAt = Number(clock())
        records.push({
          key: String(key),
          label: String(label),
          status: 'ERROR',
          startedAt: isoTime(startedAt),
          finishedAt: isoTime(finishedAt),
          durationMs: Math.max(0, finishedAt - startedAt),
          dataAsOf: null,
          errorCode: safeErrorCode(error),
        })
        throw error
      }
    },
    skip(key, label, reason = 'SKIPPED') {
      const at = Number(clock())
      records.push({
        key: String(key),
        label: String(label),
        status: 'SKIPPED',
        startedAt: isoTime(at),
        finishedAt: isoTime(at),
        durationMs: 0,
        dataAsOf: null,
        errorCode: String(reason || 'SKIPPED').slice(0, 64),
      })
    },
    snapshot() {
      return records.map((record) => ({ ...record }))
    },
  }
}

export function resolveEvidenceAccountRevision(
  payload = {},
  authenticatedAccount = null,
) {
  const authoritative = finite(authenticatedAccount?.clientRevision)
  if (authoritative != null) return authoritative
  return finite(payload?.accountRevision)
}

export function createCanonicalEvidenceSnapshot({
  mode,
  payload = {},
  accountRevision = null,
  promptVersion = 'advisor-system.v1',
  collectorVersion = EVIDENCE_COLLECTOR_VERSION,
  sourceTrace = [],
  now = Date.now(),
} = {}) {
  const asOf = new Date(now).toISOString()
  const quote = payload.todayQuote || null
  const quant = payload.quant || null
  const account = payload.account || {}
  const accountEvidence = {
    revision: finite(accountRevision),
    holdCost: finite(payload.holdCost),
    holdQty: finite(payload.holdQty),
    sellableTodayQty: finite(payload.sellableTodayQty),
    openTNet: finite(payload.openTNet),
    cash: finite(account.cash),
    totalAssets: finite(account.totalAssets),
    position: finite(account.position),
    stockWeight: finite(account.stockWeight),
    cashReservePct: finite(account.cashReservePct),
    maxStockWeight: finite(account.maxStockWeight),
    industryWeights: compact(account.industryWeights || []),
  }
  const hasAccount = Object.entries(accountEvidence)
    .some(([key, value]) =>
      !['revision', 'industryWeights'].includes(key)
      && value != null
    )
  const selectedQuantVersion = quant?.selectedModelVersion
    || payload.quantModelVersion
    || null
  const runtimeQuantVersion = quant?.runtimeModelVersion
    || quant?.modelVersion
    || null
  const sources = {
    account: source(
      hasAccount,
      hasAccount ? 'CAPTURED' : 'MISSING',
      accountEvidence.revision != null ? `revision:${accountEvidence.revision}` : null,
      asOf,
    ),
    quote: source(
      !!quote,
      quote?.live ? 'LIVE' : 'CLOSE',
      quote?.asOfLabel,
      asOf,
    ),
    market: source(
      !!payload.market,
      'AVAILABLE',
      quote?.asOfLabel || payload.dailyReport?.day,
      asOf,
    ),
    technical: source(
      !!(payload.tech || payload.history || payload.intraday),
      quote?.live ? 'LIVE' : 'CLOSE',
      quote?.asOfLabel,
      asOf,
    ),
    funds: source(
      !!(payload.stockFund || payload.marketFlow),
      'AVAILABLE',
      payload.stockFund?.asOfDate || quote?.asOfLabel,
      asOf,
    ),
    news: source(
      !!(
        payload.newsHeadlines?.length
        || payload.macroNews?.length
        || payload.macroFlashes?.length
      ),
      'AVAILABLE',
      quote?.asOfLabel || payload.dailyReport?.day,
      asOf,
    ),
    quant: source(
      !!quant,
      'AVAILABLE',
      quant?.asOf,
      asOf,
    ),
    dailyReport: source(
      !!payload.dailyReport,
      'AVAILABLE',
      payload.dailyReport?.day,
      asOf,
    ),
  }
  const requiredSources = ['account', 'quote', 'market', 'quant']
  const missingSources = Object.entries(sources)
    .filter(([, item]) => !item.available)
    .map(([key]) => key)
  const missingRequired = requiredSources.some((key) => !sources[key].available)
  const freshnessStatus = missingRequired
    ? 'PARTIAL'
    : quote?.live
      ? 'LIVE'
      : 'CLOSE'
  const evidence = {
    quote: compact(quote),
    market: compact({
      breadth: payload.market,
      environment: payload.marketEnv,
      flow: payload.marketFlow,
    }),
    technical: compact({
      indicators: payload.tech,
      history: payload.history,
      intraday: payload.intraday,
      profile: payload.stockProfile,
    }),
    funds: compact(payload.stockFund),
    quant: compact({
      score: quant?.score,
      bias: quant?.bias,
      forecast: quant?.forecast,
      highConfSignal: quant?.highConfSignal,
      reliability: quant?.reliability,
      eventTag: payload.eventSignal,
    }),
    news: compact({
      headlines: payload.newsHeadlines || [],
      macro: payload.macroNews || [],
      flashes: payload.macroFlashes || [],
    }),
    decisionSignals: compact({
      resonance: payload.resonance,
      trustScore: payload.trustScore,
      counterTrend: payload.counterTrend,
      backtest: payload.backtest,
      lhb: payload.lhb,
    }),
  }
  const collectionSources = compact(sourceTrace || [])
  const collectionStartedAt = collectionSources
    .map((item) => Date.parse(item?.startedAt || ''))
    .filter(Number.isFinite)
  const collectionFinishedAt = collectionSources
    .map((item) => Date.parse(item?.finishedAt || ''))
    .filter(Number.isFinite)
  const collection = {
    sources: collectionSources,
    sourceDurationMs: collectionSources.reduce(
      (sum, item) => sum + (finite(item?.durationMs) || 0),
      0,
    ),
    wallClockMs: collectionStartedAt.length && collectionFinishedAt.length
      ? Math.max(
        0,
        Math.max(...collectionFinishedAt)
          - Math.min(...collectionStartedAt),
      )
      : 0,
    failedSources: collectionSources
      .filter((item) => item?.status === 'ERROR')
      .map((item) => item.key),
    emptySources: collectionSources
      .filter((item) => item?.status === 'EMPTY')
      .map((item) => item.key),
  }
  const snapshot = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    snapshotId: '',
    asOf,
    mode: String(mode || ''),
    security: {
      code: String(payload.code || ''),
      name: String(payload.name || payload.todayQuote?.name || ''),
    },
    marketTime: {
      phase: quote?.phase || payload.marketPhase || null,
      dataDayLabel: quote?.asOfLabel || payload.dailyReport?.day || null,
      isLive: !!quote?.live,
    },
    account: compact(accountEvidence),
    quant: {
      selectedModelVersion: selectedQuantVersion,
      runtimeModelVersion: runtimeQuantVersion,
      asOf: quant?.asOf || null,
    },
    sourceVersion: {
      schema: EVIDENCE_SCHEMA_VERSION,
      collector: collectorVersion,
      prompt: promptVersion,
      quant: runtimeQuantVersion || selectedQuantVersion,
      accountRevision: finite(accountRevision),
    },
    sources,
    freshness: {
      status: freshnessStatus,
      missingSources,
    },
    collection,
    evidence,
  }
  snapshot.snapshotId = `ev_${Math.trunc(now).toString(36)}_${hashText(JSON.stringify(snapshot))}`
  return snapshot
}

function snapshotTime(snapshot) {
  return Date.parse(snapshot?.asOf || '') || 0
}

export function mergeEvidenceSnapshotIndexes(
  primary = {},
  secondary = {},
  limit = EVIDENCE_SNAPSHOT_LIMIT,
) {
  const merged = new Map()
  for (const snapshot of [
    ...Object.values(primary || {}),
    ...Object.values(secondary || {}),
  ]) {
    if (!snapshot?.snapshotId) continue
    const current = merged.get(snapshot.snapshotId)
    if (!current || snapshotTime(snapshot) >= snapshotTime(current)) {
      merged.set(snapshot.snapshotId, snapshot)
    }
  }
  return Object.fromEntries(
    [...merged.values()]
      .sort((left, right) => snapshotTime(right) - snapshotTime(left))
      .slice(0, Math.max(1, Number(limit) || EVIDENCE_SNAPSHOT_LIMIT))
      .map((snapshot) => [snapshot.snapshotId, snapshot]),
  )
}

export function addEvidenceSnapshot(
  data,
  snapshot,
  limit = EVIDENCE_SNAPSHOT_LIMIT,
) {
  if (!data || typeof data !== 'object' || !snapshot?.snapshotId) return false
  data.evidenceSnapshots = mergeEvidenceSnapshotIndexes(
    data.evidenceSnapshots,
    { [snapshot.snapshotId]: snapshot },
    limit,
  )
  return true
}

export function evidenceSnapshotsFromData(data = {}) {
  const snapshots = {}
  const collect = (value) => {
    const snapshot = value?.meta?.evidenceSnapshot
      || value?.evidenceSnapshot
    if (snapshot?.snapshotId) snapshots[snapshot.snapshotId] = snapshot
  }
  Object.values(data.advice || {}).forEach(collect)
  Object.values(data.reviews || {}).forEach(collect)
  return snapshots
}

export function evidenceSnapshotRef(snapshot) {
  if (!snapshot?.snapshotId) return null
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    asOf: snapshot.asOf,
    accountRevision: snapshot.account?.revision ?? null,
    quantModelVersion: snapshot.quant?.runtimeModelVersion
      || snapshot.quant?.selectedModelVersion
      || null,
    freshness: snapshot.freshness?.status || 'PARTIAL',
  }
}

export function evidencePersistenceFields(advice = {}) {
  const reference = advice?.evidenceSnapshotRef
  if (!reference?.snapshotId) return {}
  return {
    evidenceSnapshotId: reference.snapshotId,
    evidenceSnapshotRef: reference,
  }
}

export function attachEvidenceSnapshot(response = {}, snapshot = null) {
  if (!snapshot?.snapshotId) return response
  const result = response.result
    && typeof response.result === 'object'
    && !Array.isArray(response.result)
    ? {
        ...response.result,
        evidenceSnapshotRef: evidenceSnapshotRef(snapshot),
      }
    : response.result
  return {
    ...response,
    ...(result !== undefined ? { result } : {}),
    meta: {
      ...(response.meta || {}),
      evidenceSnapshot: snapshot,
    },
  }
}
