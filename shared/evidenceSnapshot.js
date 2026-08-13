export const EVIDENCE_SCHEMA_VERSION = 'canonical-evidence.v1'
export const EVIDENCE_COLLECTOR_VERSION = 'ai-collector.v1'

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
    evidence,
  }
  snapshot.snapshotId = `ev_${Math.trunc(now).toString(36)}_${hashText(JSON.stringify(snapshot))}`
  return snapshot
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
