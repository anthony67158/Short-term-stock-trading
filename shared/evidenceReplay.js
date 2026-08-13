const REPLAY_SCHEMA_VERSION = 'evidence-replay.v1'
const COMPARISON_SCHEMA_VERSION = 'evidence-comparison.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hashText(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function pathValue(value, path) {
  return path.split('.').reduce(
    (current, key) => current?.[key],
    value,
  )
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function compactLinkedRecord(record, type) {
  return {
    type,
    id: record?.id || null,
    code: record?.code || null,
    mode: record?.mode || null,
    kind: record?.kind || null,
    action: record?.action
      || record?.advice?.action
      || record?.result?.stance
      || null,
    at: finite(record?.at),
  }
}

export function replayEvidenceSnapshot(snapshot = {}) {
  const account = snapshot.account || {}
  const quote = snapshot.evidence?.quote || {}
  const marketEnvironment = snapshot.evidence?.market?.environment || {}
  const quantEvidence = snapshot.evidence?.quant || {}
  const selectedModelVersion = snapshot.quant?.selectedModelVersion || null
  const runtimeModelVersion = snapshot.quant?.runtimeModelVersion || null
  const rawHoldQty = finite(account.holdQty)
  const holdQty = rawHoldQty == null ? null : Math.max(0, rawHoldQty)
  const rawSellable = finite(account.sellableTodayQty)
  const sellableTodayQty = holdQty == null || rawSellable == null
    ? null
    : Math.max(0, Math.min(holdQty, rawSellable))
  const t1LockedQty = holdQty == null || sellableTodayQty == null
    ? null
    : Math.max(0, +(holdQty - sellableTodayQty).toFixed(3))
  const position = finite(account.position)
  const stockWeight = finite(account.stockWeight)
  const cashReservePct = finite(account.cashReservePct)
  const marketScore = finite(marketEnvironment.score)
  const marketWeak = marketEnvironment.weak === true
    || (marketScore != null && marketScore <= 44)
  const failedSources = Array.isArray(snapshot.collection?.failedSources)
    ? [...snapshot.collection.failedSources].sort()
    : []
  const emptySources = Array.isArray(snapshot.collection?.emptySources)
    ? [...snapshot.collection.emptySources].sort()
    : []
  const missingSources = Array.isArray(snapshot.freshness?.missingSources)
    ? [...snapshot.freshness.missingSources].sort()
    : []
  const replay = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    snapshotId: String(snapshot.snapshotId || ''),
    sourceSchemaVersion: snapshot.schemaVersion || null,
    asOf: snapshot.asOf || null,
    mode: snapshot.mode || null,
    security: {
      code: snapshot.security?.code || null,
      name: snapshot.security?.name || null,
    },
    replayable: !!(
      snapshot.snapshotId
      && snapshot.schemaVersion === 'canonical-evidence.v1'
      && snapshot.security?.code
      && snapshot.asOf
    ),
    marketTime: {
      phase: snapshot.marketTime?.phase || null,
      dataDayLabel: snapshot.marketTime?.dataDayLabel || null,
      isLive: snapshot.marketTime?.isLive === true,
    },
    account: {
      revision: finite(account.revision),
      holdCost: finite(account.holdCost),
      holdQty,
      sellableTodayQty,
      t1LockedQty,
      cash: finite(account.cash),
      totalAssets: finite(account.totalAssets),
      position,
      stockWeight,
      cashReservePct,
    },
    quote: {
      price: finite(quote.price),
      pct: finite(quote.pct),
      prevClose: finite(quote.prevClose),
      limitUpPrice: finite(quote.limitUpPrice),
      limitDownPrice: finite(quote.limitDownPrice),
      isLimitUp: quote.isLimitUp === true,
      isLimitDown: quote.isLimitDown === true,
    },
    market: {
      score: marketScore,
      level: marketEnvironment.level || null,
      weak: marketWeak,
    },
    quant: {
      selectedModelVersion,
      runtimeModelVersion,
      didFallback: !!(
        selectedModelVersion
        && runtimeModelVersion
        && selectedModelVersion !== runtimeModelVersion
      ),
      score: finite(quantEvidence.score),
      bias: quantEvidence.bias || null,
      upProb: finite(quantEvidence.forecast?.upProb),
      expRet: finite(quantEvidence.forecast?.expRet),
      direction: quantEvidence.forecast?.direction || null,
      highConfidence: quantEvidence.highConfSignal?.fired === true,
    },
    constraints: {
      t1Locked: t1LockedQty == null ? null : t1LockedQty > 0,
      noSellableShares: holdQty == null || sellableTodayQty == null
        ? null
        : holdQty > 0 && sellableTodayQty <= 0,
      totalPositionHigh: position != null && position >= 85,
      cashReserveLow: cashReservePct != null && cashReservePct < 10,
      stockConcentrated: stockWeight != null && stockWeight >= 25,
      weakMarket: marketWeak,
    },
    quality: {
      freshness: snapshot.freshness?.status || 'PARTIAL',
      missingSources,
      failedSources,
      emptySources,
      sourceCount: Array.isArray(snapshot.collection?.sources)
        ? snapshot.collection.sources.length
        : 0,
      wallClockMs: finite(snapshot.collection?.wallClockMs) || 0,
    },
    versions: {
      collector: snapshot.sourceVersion?.collector || null,
      prompt: snapshot.sourceVersion?.prompt || null,
      quant: snapshot.sourceVersion?.quant || null,
      accountRevision: finite(snapshot.sourceVersion?.accountRevision),
    },
    fingerprint: '',
  }
  replay.fingerprint = `replay.${hashText(JSON.stringify(replay))}`
  return replay
}

const COMPARISON_FIELDS = [
  ['account.revision', '账户版本', 'MEDIUM'],
  ['account.holdCost', '持仓成本', 'MEDIUM'],
  ['account.holdQty', '持仓手数', 'HIGH'],
  ['account.sellableTodayQty', '今日可卖', 'HIGH'],
  ['account.t1LockedQty', 'T+1锁定', 'HIGH'],
  ['account.cash', '可用现金', 'MEDIUM'],
  ['account.totalAssets', '总资产', 'LOW'],
  ['account.position', '总仓位', 'HIGH'],
  ['account.stockWeight', '单票占比', 'HIGH'],
  ['account.cashReservePct', '现金储备', 'HIGH'],
  ['quote.price', '价格', 'HIGH'],
  ['quote.pct', '涨跌幅', 'HIGH'],
  ['quote.isLimitUp', '涨停状态', 'HIGH'],
  ['quote.isLimitDown', '跌停状态', 'HIGH'],
  ['market.score', '市场环境分', 'MEDIUM'],
  ['market.level', '市场环境', 'MEDIUM'],
  ['market.weak', '弱市状态', 'HIGH'],
  ['quant.selectedModelVersion', '所选量化模型', 'MEDIUM'],
  ['quant.runtimeModelVersion', '实际量化模型', 'HIGH'],
  ['quant.didFallback', '量化回退', 'HIGH'],
  ['quant.score', '量化分', 'MEDIUM'],
  ['quant.bias', '量化倾向', 'MEDIUM'],
  ['quant.upProb', '上涨概率', 'MEDIUM'],
  ['quant.expRet', '预期收益', 'MEDIUM'],
  ['quant.direction', '预测方向', 'HIGH'],
  ['quant.highConfidence', '高把握信号', 'HIGH'],
  ['quality.freshness', '证据时效', 'HIGH'],
  ['quality.missingSources', '缺失来源', 'HIGH'],
  ['quality.failedSources', '失败来源', 'MEDIUM'],
  ['versions.collector', '采集器版本', 'MEDIUM'],
  ['versions.prompt', 'Prompt版本', 'MEDIUM'],
  ['versions.quant', '量化版本', 'HIGH'],
]

export function compareEvidenceSnapshots(fromSnapshot, toSnapshot) {
  const fromReplay = replayEvidenceSnapshot(fromSnapshot)
  const toReplay = replayEvidenceSnapshot(toSnapshot)
  const base = {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    fromSnapshotId: fromReplay.snapshotId,
    toSnapshotId: toReplay.snapshotId,
    security: toReplay.security,
    comparable: true,
    reason: null,
    changes: [],
    summary: {
      totalChanges: 0,
      high: 0,
      medium: 0,
      low: 0,
      hasMaterialChange: false,
    },
  }
  if (
    fromReplay.sourceSchemaVersion !== toReplay.sourceSchemaVersion
  ) {
    return {
      ...base,
      comparable: false,
      reason: 'SCHEMA_MISMATCH',
    }
  }
  if (
    !fromReplay.security.code
    || !toReplay.security.code
    || fromReplay.security.code !== toReplay.security.code
  ) {
    return {
      ...base,
      comparable: false,
      reason: 'SECURITY_MISMATCH',
    }
  }

  for (const [path, label, severity] of COMPARISON_FIELDS) {
    const before = pathValue(fromReplay, path)
    const after = pathValue(toReplay, path)
    if (sameValue(before, after)) continue
    base.changes.push({
      path,
      label,
      severity,
      before: before ?? null,
      after: after ?? null,
    })
    base.summary[severity.toLowerCase()]++
  }
  base.summary.totalChanges = base.changes.length
  base.summary.hasMaterialChange = (
    base.summary.high > 0
    || base.summary.medium >= 2
  )
  return base
}

export function findSnapshotLinkedRecords(data = {}, snapshotId) {
  const matches = (value) => {
    const ids = [
      value?.evidenceSnapshotId,
      value?.evidenceSnapshotRef?.snapshotId,
      value?.advice?.evidenceSnapshotRef?.snapshotId,
      value?.result?.evidenceSnapshotRef?.snapshotId,
      value?.meta?.evidenceSnapshot?.snapshotId,
    ]
    return ids.includes(snapshotId)
  }
  return {
    advice: Object.values(data.advice || {})
      .filter(matches)
      .map((record) => compactLinkedRecord(record, 'advice')),
    reviews: Object.values(data.reviews || {})
      .filter(matches)
      .map((record) => compactLinkedRecord(record, 'review')),
    decisionEvents: (data.decisionLog || [])
      .filter(matches)
      .map((record) => compactLinkedRecord(record, 'decision')),
  }
}
