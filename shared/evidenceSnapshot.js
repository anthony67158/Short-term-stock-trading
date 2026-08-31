export const EVIDENCE_SCHEMA_VERSION = 'canonical-evidence.v1'
export const EVIDENCE_COLLECTOR_VERSION = 'ai-collector.v1'
export const EVIDENCE_SNAPSHOT_LIMIT = 80

const REQUIRED_SOURCE_KEYS = Object.freeze([
  'account',
  'quote',
  'market',
  'quant',
])

const SOURCE_DIAGNOSTICS = Object.freeze({
  account: {
    label: '账户风险事实',
    impact: '无法计算可用现金、当前仓位和单票风险预算',
    recovery: '等待账号同步完成后重新生成',
  },
  quote: {
    label: '个股行情',
    impact: '无法确认当前价、涨跌幅和行情时效',
    recovery: '等待行情接口恢复后重新生成',
  },
  market: {
    label: '市场状态',
    impact: '无法判断当前环境是否允许新增风险及目标仓位上限',
    recovery: '等待大盘广度与量能数据恢复后重新生成',
  },
  quant: {
    label: '量化预测',
    impact: '无法验证方向概率、预期收益和目标价区间',
    recovery: '等待K线与量化服务恢复后重新生成',
  },
  technical: {
    label: '技术面',
    impact: '无法校验趋势结构与关键支撑压力',
    recovery: '等待K线数据恢复后重新生成',
  },
  funds: {
    label: '资金面',
    impact: '无法确认主力资金方向',
    recovery: '等待资金流接口恢复后重新生成',
  },
  news: {
    label: '消息面',
    impact: '无法核验近期公告、政策和舆情',
    recovery: '等待检索或公告数据恢复后重新生成',
  },
  dailyReport: {
    label: '策略日报',
    impact: '缺少全市场场次背景，只能降低该项证据权重',
    recovery: '日报恢复后在下一轮复核补齐',
  },
})

const SOURCE_TRACE_KEYS = Object.freeze({
  quote: ['quote'],
  market: ['market'],
  quant: ['quant', 'dailyCandles'],
  technical: ['dailyCandles', 'intraday'],
  funds: ['stockFunds', 'sectorFlow'],
  news: ['stockNews', 'macroNews', 'stockSearch', 'industrySearch'],
  dailyReport: ['dailyReport'],
})

const SKIP_REASON_LABELS = Object.freeze({
  TRIGGERED_REVIEW_REUSE_PREVIOUS:
    '原建议没有可复用的量化结果，本轮快速复核不重复计算',
  TRIGGERED_REVIEW_FAST_PATH:
    '到价复核只采集当前决策所需的实时证据',
  QUICK_ADVICE_FAST_PATH:
    '快速建议只采集价格决策所需证据',
  QUICK_ADVICE_SKIP_LIVE_SEARCH:
    '快速建议不等待联网检索',
})

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

function source(available, state, dataAsOf, observedAt, basisLabel = null) {
  return {
    available: !!available,
    state: available ? state : 'MISSING',
    dataAsOf: dataAsOf || null,
    observedAt,
    basisLabel: available ? (basisLabel || null) : null,
  }
}

function marketEvidenceContext(payload, quote) {
  const phase = String(quote?.phase || payload?.marketPhase || '')
  if (quote?.stale === true || payload?.evidenceStale === true) {
    return {
      state: 'STALE',
      basisLabel: '过期快照，仅作背景参考',
    }
  }
  if (phase.includes('午间')) {
    return {
      state: 'SESSION_CLOSE',
      basisLabel: '今日上午收盘快照',
    }
  }
  if (phase.includes('盘后') || phase.includes('已收盘')) {
    return {
      state: 'DAY_CLOSE',
      basisLabel: '今日完整收盘数据',
    }
  }
  if (phase.includes('休市') || phase.includes('盘前')) {
    return {
      state: 'PREVIOUS_CLOSE',
      basisLabel: '最近交易日完整数据',
    }
  }
  if (quote?.live === true) {
    return {
      state: 'LIVE',
      basisLabel: '当前交易时段实时数据',
    }
  }
  return {
    state: 'PREVIOUS_CLOSE',
    basisLabel: '最近有效收盘数据',
  }
}

function isoTime(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function safeErrorCode(error) {
  const code = String(error?.code || error?.name || 'Error')
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code) ? code : 'Error'
}

function traceForSource(sourceKey, sourceTrace = []) {
  const keys = SOURCE_TRACE_KEYS[sourceKey] || []
  for (const key of keys) {
    const trace = sourceTrace.find((item) => item?.key === key)
    if (trace) return trace
  }
  return null
}

function missingReason(sourceKey, trace) {
  const code = String(trace?.errorCode || '')
  const http = code.match(/^HTTP_(\d{3})$/)
  if (http) return `接口返回 HTTP ${http[1]}`
  if (
    code === 'INSUFFICIENT_CANDLES'
    || code === 'INSUFFICIENT_DAILY_CANDLES'
  ) {
    return '当前生产模型所需日K线数据不足，已尝试主源和备用源'
  }
  if (code === 'AbortError') return '数据采集超时'
  if (trace?.status === 'OK') {
    return '接口返回成功，但证据组装未完成'
  }
  if (trace?.status === 'EMPTY') return '接口已响应，但没有返回可用数据'
  if (trace?.status === 'SKIPPED') {
    return SKIP_REASON_LABELS[code]
      || '该项不属于本轮必需证据，未重复采集'
  }
  if (trace?.status === 'ERROR') {
    return code ? `数据采集失败（${code}）` : '数据采集失败'
  }
  if (sourceKey === 'account') return '账号快照未包含完整资金或持仓事实'
  return '本轮未取得有效数据，且没有可用采集记录'
}

function missingEvidenceDetails(missingSources, sourceTrace) {
  return missingSources.map((sourceKey) => {
    const trace = traceForSource(sourceKey, sourceTrace)
    const metadata = SOURCE_DIAGNOSTICS[sourceKey] || {
      label: sourceKey,
      impact: '该项证据无法参与本轮决策',
      recovery: '数据恢复后重新生成',
    }
    return {
      source: sourceKey,
      label: metadata.label,
      status: trace?.status || 'MISSING',
      reason: missingReason(sourceKey, trace),
      impact: metadata.impact,
      recovery: metadata.recovery,
      required: REQUIRED_SOURCE_KEYS.includes(sourceKey),
      traceKey: trace?.key || null,
      errorCode: trace?.errorCode || null,
    }
  })
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
  const marketEvidence = marketEvidenceContext(payload, quote)
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
  const quantTrace = traceForSource('quant', sourceTrace)
  const reusedQuant = (
    quantTrace?.status === 'SKIPPED'
    && quantTrace?.errorCode === 'TRIGGERED_REVIEW_REUSE_PREVIOUS'
  )
    ? (
        payload.reviewDecisionPacket?.baseline?.tactical?.quant
        || payload.previousAdvice?.shortHorizonTactical?.quant
        || payload.previousAdvice?.quantContext
        || null
      )
    : null
  const effectiveQuant = quant || reusedQuant
  const selectedQuantVersion = effectiveQuant?.selectedModelVersion
    || payload.quantModelVersion
    || null
  const runtimeQuantVersion = effectiveQuant?.runtimeModelVersion
    || effectiveQuant?.modelVersion
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
      marketEvidence.state,
      quote?.asOfLabel,
      asOf,
      marketEvidence.basisLabel,
    ),
    market: source(
      !!payload.market,
      marketEvidence.state,
      quote?.asOfLabel || payload.dailyReport?.day,
      asOf,
      marketEvidence.basisLabel,
    ),
    technical: source(
      !!(payload.tech || payload.history || payload.intraday),
      marketEvidence.state,
      quote?.asOfLabel,
      asOf,
      marketEvidence.basisLabel,
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
        || payload.aiSearchEvidence?.length
      ),
      'AVAILABLE',
      quote?.asOfLabel || payload.dailyReport?.day,
      asOf,
    ),
    quant: source(
      !!effectiveQuant,
      reusedQuant ? 'REUSED' : marketEvidence.state,
      effectiveQuant?.inputAsOf || effectiveQuant?.asOf,
      asOf,
      reusedQuant ? '复用原建议量化结果' : marketEvidence.basisLabel,
    ),
    dailyReport: source(
      !!payload.dailyReport,
      'AVAILABLE',
      payload.dailyReport?.day,
      asOf,
    ),
  }
  const missingSources = Object.entries(sources)
    .filter(([, item]) => !item.available)
    .map(([key]) => key)
  const missingRequiredSources = REQUIRED_SOURCE_KEYS
    .filter((key) => !sources[key].available)
  const missingRequired = missingRequiredSources.length > 0
  const missingDetails = missingEvidenceDetails(
    missingSources,
    sourceTrace,
  )
  const freshnessStatus = missingRequired
    ? 'PARTIAL'
    : marketEvidence.state
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
      score: effectiveQuant?.score,
      bias: effectiveQuant?.bias,
      forecast: effectiveQuant?.forecast,
      highConfSignal: effectiveQuant?.highConfSignal,
      reliability: effectiveQuant?.reliability,
      eventTag: payload.eventSignal,
    }),
    news: compact({
      headlines: payload.newsHeadlines || [],
      macro: payload.macroNews || [],
      flashes: payload.macroFlashes || [],
      aiSearch: payload.aiSearchEvidence || [],
    }),
    decisionSignals: compact({
      tactical: payload.shortHorizonTactical,
      resonance: payload.resonance,
      trustScore: payload.trustScore,
      counterTrend: payload.counterTrend,
      backtest: payload.backtest,
      lhb: payload.lhb,
      sectorOpportunity: payload.sectorOpportunity,
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
      evidenceState: marketEvidence.state,
      basisLabel: marketEvidence.basisLabel,
    },
    account: compact(accountEvidence),
    quant: {
      selectedModelVersion: selectedQuantVersion,
      runtimeModelVersion: runtimeQuantVersion,
      asOf: quant?.asOf || null,
      ...(quant?.inputAsOf ? {
        inputAsOf: quant.inputAsOf,
        inputSource: quant.inputSource || null,
      } : {}),
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
      missingRequiredSources,
      missingDetails,
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
