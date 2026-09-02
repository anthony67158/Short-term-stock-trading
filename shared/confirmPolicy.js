const POLICY = {
  buy: {
    minObserveMs: 0,
    deterministicConfirm: 2.5,
    llmConfidence: 78,
  },
  sell: {
    minObserveMs: 60 * 1000,
    deterministicConfirm: 1.5,
    llmConfidence: 70,
  },
  stop: {
    minObserveMs: 20 * 1000,
    deterministicConfirm: 1.5,
    hardOverride: 3,
    llmConfidence: 65,
  },
}

export function resolveDecisionSide(verdict, fallback) {
  const allowed = new Set(['buy', 'sell', 'stop'])
  const candidate = String(verdict?.side || '')
  return allowed.has(candidate) ? candidate : (allowed.has(fallback) ? fallback : null)
}

export function confirmationPolicy(side) {
  return POLICY[side] || POLICY.buy
}

export function shouldRequestConfirmation(
  side,
  watchingAt,
  now = Date.now(),
  context = {},
) {
  if (
    side === 'stop'
    && Number(context.threshold) > 0
    && Number(context.price) > 0
    && (
      Number(context.threshold) - Number(context.price)
    ) / Number(context.threshold) >= 0.01
  ) {
    return true
  }
  const startedAt = Number(watchingAt)
  if (!Number.isFinite(startedAt) || startedAt <= 0) return true
  return now - startedAt >= confirmationPolicy(side).minObserveMs
}

export function shouldConfirmImmediatelyAfterTouch(side) {
  return side === 'buy'
}

export async function resolveImmediateConfirmationAlert({
  side,
  alertId,
  flushSave,
  getAlerts,
} = {}) {
  if (
    !shouldConfirmImmediatelyAfterTouch(side)
    || typeof flushSave !== 'function'
    || typeof getAlerts !== 'function'
  ) {
    return null
  }
  const saved = await flushSave()
  if (!saved) return null
  return (getAlerts() || []).find((alert) =>
    String(alert?.id || '') === String(alertId || '')
    && alert.enabled
    && alert.phase === 'watching'
  ) || null
}

export function shouldCallLlmJudge(side, deterministic) {
  return !!confirmationPolicy(side)
    && deterministic?.decision !== 'invalid'
}

export function fuseConfirmation({
  side,
  deterministic,
  llm,
  observationAgeMs,
} = {}) {
  const policy = confirmationPolicy(side)
  const det = deterministic || { decision: 'wait', score: 0, hits: [] }
  const score = Number(det.score) || 0
  const observed = !Number.isFinite(observationAgeMs) || observationAgeMs >= policy.minObserveMs

  if (det.decision === 'invalid') {
    if (!llm || llm.decision === 'invalid' || side === 'buy') {
      return {
        decision: 'invalid',
        confidence: llm?.confidence ?? null,
        reason: llm?.reason || det.hits?.join('、') || '客观失效条件已触发',
        policy: 'deterministic-invalid',
      }
    }
  }

  if (side === 'stop' && det.decision === 'confirm' && score >= policy.hardOverride) {
    return {
      decision: 'confirm',
      confidence: llm?.confidence ?? null,
      reason: det.hits?.join('、') || '强客观破位信号确认止损',
      policy: 'risk-override',
      rawDecision: llm?.decision || det.decision,
    }
  }

  if (!observed) {
    return {
      decision: 'wait',
      confidence: llm?.confidence ?? null,
      reason: `刚触价，至少观察${Math.ceil(policy.minObserveMs / 60000)}分钟再确认`,
      gated: true,
      rawDecision: llm?.decision || det.decision,
      policy: 'observation',
    }
  }

  if (llm?.decision === 'invalid') {
    return {
      decision: 'invalid',
      confidence: llm.confidence ?? null,
      reason: llm.reason || '本次交易逻辑已经失效',
      rawDecision: 'invalid',
      policy: 'llm-invalid',
    }
  }

  if (!llm) {
    return {
      decision: det.decision === 'confirm' && score >= policy.deterministicConfirm ? 'confirm' : 'wait',
      confidence: null,
      reason: det.hits?.length ? det.hits.join('、') : '证据不足，本次不执行',
      policy: 'deterministic-fallback',
    }
  }

  if (llm.decision !== 'confirm') {
    return {
      decision: 'wait',
      confidence: llm.confidence ?? null,
      reason: llm.reason || '模型本轮决定不执行',
      policy: 'llm-wait',
    }
  }

  if (!Number.isFinite(llm.confidence)) {
    return {
      decision: 'wait',
      confidence: null,
      reason: '模型未提供有效置信度，本次不执行',
      gated: true,
      rawDecision: 'confirm',
      policy: 'confidence-gated',
    }
  }

  if (llm.confidence < policy.llmConfidence) {
    return {
      decision: 'wait',
      confidence: llm.confidence,
      reason: `模型把握不足(${llm.confidence}<${policy.llmConfidence})，本次不执行：${llm.reason || ''}`,
      gated: true,
      rawDecision: 'confirm',
      policy: 'confidence-gated',
    }
  }

  return {
    decision: 'confirm',
    confidence: llm.confidence,
    reason: llm.reason || det.hits?.join('、') || '模型与客观信号共振',
    policy: 'consensus',
  }
}

export function directionalOutcome(side, entryPrice, laterPrice) {
  const entry = Number(entryPrice)
  const later = Number(laterPrice)
  if (!(entry > 0) || !(later > 0)) return null
  const direction = side === 'buy' ? 1 : -1
  return +(((later - entry) / entry) * 100 * direction).toFixed(2)
}

export function collectOutcomeSnapshots(alert, currentPrice, now = Date.now()) {
  const outcomes = { ...(alert?.judgeOutcomes || {}) }
  const triggeredAt = Number(alert?.triggeredAt)
  const entryPrice = Number(alert?.decisionPrice)
  const side = alert?.decisionSide
  const price = Number(currentPrice)
  if (alert?.phase !== 'confirmed' || !(triggeredAt > 0) || !(entryPrice > 0) || !(price > 0) || !side) {
    return { changed: false, outcomes }
  }
  let changed = false
  for (const minutes of [5, 15, 30]) {
    const key = `m${minutes}`
    if (outcomes[key] || now - triggeredAt < minutes * 60 * 1000) continue
    outcomes[key] = {
      at: now,
      price,
      rawPct: +(((price - entryPrice) / entryPrice) * 100).toFixed(2),
      directionalPct: directionalOutcome(side, entryPrice, price),
    }
    changed = true
  }
  return { changed, outcomes }
}

export function duplicateSmartAlerts(alerts = [], sideResolver = () => 'unknown') {
  const groups = new Map()
  for (const alert of alerts) {
    if (!alert?.id || !alert.enabled || alert.type !== 'price' || !alert.phase) continue
    if (alert.phase === 'confirmed' || alert.phase === 'invalid' || alert.phase === 'superseded') continue
    const side = sideResolver(alert)
    const price = Number(alert.value)
    if (!Number.isFinite(price)) continue
    const key = `${alert.code}|${side}|${alert.op}|${price.toFixed(4)}`
    const items = groups.get(key) || []
    items.push(alert)
    groups.set(key, items)
  }
  const duplicates = []
  for (const items of groups.values()) {
    if (items.length < 2) continue
    const priority = (alert) =>
      (alert.phase === 'watching' ? 100 : 0) +
      (alert.timing ? 10 : 0) +
      (alert.actKind ? 5 : 0) +
      (alert.opQty ? 1 : 0)
    const sorted = items.slice().sort((a, b) => priority(b) - priority(a))
    for (const duplicate of sorted.slice(1)) {
      duplicates.push({ id: duplicate.id, primaryId: sorted[0].id })
    }
  }
  return duplicates
}

export function judgeEffectStats(records = []) {
  const confirmedByAlert = new Map()
  for (const record of records) {
    if (record?.phase !== 'confirmed' && record?.kind !== 'judge') continue
    const key = record.alertId || record.id
    if (!key) continue
    const current = confirmedByAlert.get(key)
    const outcomeRank = (item) => item?.judgeOutcomes?.m30 ? 3 : item?.judgeOutcomes?.m15 ? 2 : item?.judgeOutcomes?.m5 ? 1 : 0
    if (!current || outcomeRank(record) > outcomeRank(current)) confirmedByAlert.set(key, record)
  }
  const confirmedAlerts = [...confirmedByAlert.values()]
  const samples = confirmedAlerts.map((alert) =>
    alert.judgeOutcomes?.m30 || alert.judgeOutcomes?.m15 || alert.judgeOutcomes?.m5 || null
  ).filter((sample) => Number.isFinite(Number(sample?.directionalPct)))
  const values = samples.map((sample) => Number(sample.directionalPct))
  const wins = values.filter((value) => value > 0).length
  return {
    confirmed: confirmedAlerts.length,
    evaluated: values.length,
    wins,
    winRate: values.length ? Math.round(wins / values.length * 100) : null,
    avgDirectionalPct: values.length
      ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)
      : null,
  }
}
