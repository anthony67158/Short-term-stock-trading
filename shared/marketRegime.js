export const MARKET_REGIME_VERSION = 'market-regime.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function clean(value, maximum = 40) {
  return String(value || '').trim().slice(0, maximum)
}

function normalizedInputs(payload = {}) {
  const breadth = payload.breadth && typeof payload.breadth === 'object'
    ? payload.breadth
    : payload
  const indices = (Array.isArray(payload.indices) ? payload.indices : [])
    .map((item) => ({
      code: clean(item?.code, 12),
      name: clean(item?.name, 30),
      pct: finite(item?.pct),
    }))
    .filter((item) => item.name && item.pct != null)
  return {
    indices,
    breadth: {
      up: finite(breadth.up),
      down: finite(breadth.down),
      flat: finite(breadth.flat),
      limitUp: finite(breadth.limitUp),
      limitDown: finite(breadth.limitDown),
      amountYi: finite(breadth.amountYi),
      volVsAvg5: finite(breadth.volVsAvg5),
      volLevel: clean(breadth.volLevel, 20),
    },
    asOf: payload.updatedAt || payload.asOf || null,
  }
}

function regimeProfile(regime) {
  return {
    TREND_STRONG: {
      label: '强势趋势',
      legacyLevel: '强势',
      portfolioRegime: 'offensive',
      targetPositionPct: { min: 50, max: 70 },
      riskMultiplier: 1,
      allowRiskIncrease: true,
    },
    RANGE: {
      label: '震荡均衡',
      legacyLevel: '中性',
      portfolioRegime: 'balanced',
      targetPositionPct: { min: 30, max: 50 },
      riskMultiplier: 0.75,
      allowRiskIncrease: true,
    },
    TRANSITION: {
      label: '方向切换',
      legacyLevel: '中性偏谨慎',
      portfolioRegime: 'balanced',
      targetPositionPct: { min: 20, max: 40 },
      riskMultiplier: 0.5,
      allowRiskIncrease: true,
    },
    RISK_OFF: {
      label: '风险防守',
      legacyLevel: '偏弱',
      portfolioRegime: 'defensive',
      targetPositionPct: { min: 0, max: 20 },
      riskMultiplier: 0.25,
      allowRiskIncrease: false,
    },
    UNKNOWN: {
      label: '数据不足',
      legacyLevel: '数据不足',
      portfolioRegime: 'defensive',
      targetPositionPct: { min: 0, max: 0 },
      riskMultiplier: 0,
      allowRiskIncrease: false,
    },
  }[regime]
}

export function deriveMarketRegime(payload = {}) {
  const { indices, breadth, asOf } = normalizedInputs(payload)
  const hasBreadth = breadth.up != null && breadth.down != null
  const hasMarketEvidence = indices.length > 0 || hasBreadth
  if (!hasMarketEvidence) {
    const profile = regimeProfile('UNKNOWN')
    return {
      schemaVersion: MARKET_REGIME_VERSION,
      regime: 'UNKNOWN',
      score: null,
      dataQuality: 'MISSING',
      weak: true,
      suggestPosition: '暂停新增风险',
      ...profile,
      indices,
      breadth,
      asOf,
      note: '市场关键证据缺失，暂停新增风险，仅允许处理已有仓位。',
    }
  }

  const averageIndexPct = indices.length
    ? indices.reduce((sum, item) => sum + item.pct, 0) / indices.length
    : 0
  const total = hasBreadth
    ? Math.max(1, breadth.up + breadth.down + (breadth.flat || 0))
    : null
  const breadthBalance = total
    ? (breadth.up - breadth.down) / total
    : 0
  let score = 50
  score += clamp(averageIndexPct * 12, -20, 20)
  if (total) score += breadthBalance * 28
  if (breadth.limitUp != null && breadth.limitDown != null) {
    score += clamp(
      (breadth.limitUp - breadth.limitDown) / 10,
      -8,
      8,
    )
  }
  if (breadth.volLevel === '放量' && averageIndexPct > 0) score += 5
  if (breadth.volLevel === '放量' && averageIndexPct < 0) score -= 5
  score = Math.round(clamp(score, 0, 100))

  let regime
  if (score >= 68) regime = 'TREND_STRONG'
  else if (score <= 44) regime = 'RISK_OFF'
  else if (
    Math.abs(averageIndexPct) <= 0.6
    && (!total || Math.abs(breadthBalance) <= 0.15)
  ) regime = 'RANGE'
  else regime = 'TRANSITION'

  const profile = regimeProfile(regime)
  const target = profile.targetPositionPct
  const indexText = indices
    .slice(0, 4)
    .map((item) => `${item.name}${item.pct >= 0 ? '+' : ''}${item.pct}%`)
    .join('，')
  const breadthText = total
    ? `上涨${breadth.up}家、下跌${breadth.down}家`
    : '涨跌家数暂缺'
  const dataQuality = indices.length > 0 && hasBreadth
    ? 'COMPLETE'
    : 'PARTIAL'
  return {
    schemaVersion: MARKET_REGIME_VERSION,
    regime,
    score,
    dataQuality,
    weak: regime === 'RISK_OFF',
    suggestPosition: `${target.min}~${target.max}%`,
    ...profile,
    indices,
    breadth,
    asOf,
    note: `市场${profile.label}（${score}分）：${indexText || '指数数据暂缺'}；${breadthText}${breadth.volLevel ? `，当前${breadth.volLevel}` : ''}。目标总仓位${target.min}~${target.max}%。`,
  }
}
