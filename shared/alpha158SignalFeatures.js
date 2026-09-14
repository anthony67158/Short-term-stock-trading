// Alpha158 连续信号 → V3 复核模型的连续特征块（路线2：作为模型输入，非硬过滤）。
//
// 与被淘汰的 jointScore 排序融合不同：这里把 Alpha158 的决策时点横截面统计
// 编码成固定顺序的连续特征向量，交给模型自己学习其边际贡献。任何缺失/过期/
// 未激活都退化为 0（中性）并置对应 Missing 掩码=1，绝不臆造分数，也绝不做
// Top50 之类的硬过滤——过滤会压缩有效机会覆盖，这是 191 日回放已证实的坑。
//
// 特征顺序必须与 contracts/opportunity-alpha158-signal.json 完全一致，
// 并由 Python 侧同名契约校验，保证跨语言逐位对齐。

export const ALPHA158_SIGNAL_FEATURE_VERSION =
  'opportunity-alpha158-signal.v1'
export const ALPHA158_RUNTIME_SNAPSHOT_VERSION =
  'alpha158-ranking-snapshot.v1'

// 与契约 featureNames 完全同序。
export const ALPHA158_SIGNAL_FEATURE_NAMES = Object.freeze([
  'alphaScoreZ',
  'alphaScorePctRank',
  'alphaScoreZMissing',
  'alphaRankIc20',
  'alphaRankIc60',
  'alphaRankIcMissing',
  'alphaScoreMomentum5',
  'alphaScoreMomentumMissing',
])

const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function compactDate(value) {
  const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/)
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

function dateTimestamp(value) {
  const date = compactDate(value)
  if (!date) return null
  const timestamp = Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+08:00`,
  )
  return Number.isFinite(timestamp) ? timestamp : null
}

export function normalizeAlpha158RuntimeSnapshot(payload = {}) {
  if (
    payload?.schemaVersion !== ALPHA158_RUNTIME_SNAPSHOT_VERSION
    || !compactDate(payload.asOfDate)
    || !payload.stocks
    || typeof payload.stocks !== 'object'
    || Array.isArray(payload.stocks)
  ) return null
  const stocks = new Map()
  for (const [code, value] of Object.entries(payload.stocks)) {
    const percentile = finite(value?.percentile)
    if (
      /^(000|001|002|003|600|601|603|605)\d{3}$/.test(code)
      && percentile != null
      && percentile >= 0
      && percentile <= 1
    ) {
      stocks.set(code, {
        percentile,
        scoreMomentum5: finite(value?.scoreMomentum5),
      })
    }
  }
  return {
    schemaVersion: ALPHA158_RUNTIME_SNAPSHOT_VERSION,
    state: (
      payload.state === 'ACTIVE'
      && payload.productionEligible === true
    ) ? 'ACTIVE' : 'RESEARCH',
    asOfDate: compactDate(payload.asOfDate),
    modelVersion: String(payload.modelVersion || '') || null,
    recentRankIc: finite(payload.metrics?.recentRankIc),
    overallRankIc: finite(payload.metrics?.overallRankIc),
    stocks,
  }
}

export function alpha158SignalFromSnapshot(snapshot, code) {
  const stock = snapshot?.stocks instanceof Map
    ? snapshot.stocks.get(String(code || ''))
    : null
  return {
    state: snapshot?.state === 'ACTIVE' && stock ? 'ACTIVE' : 'UNAVAILABLE',
    asOfDate: snapshot?.asOfDate || null,
    modelVersion: snapshot?.modelVersion || null,
    percentile: stock?.percentile ?? null,
    recentRankIc: snapshot?.recentRankIc ?? null,
    overallRankIc: snapshot?.overallRankIc ?? null,
    scoreMomentum5: stock?.scoreMomentum5 ?? null,
  }
}

// 把 percentile(0..1)映射到以 0 为中心的近似 z 分（[-1,1] 线性），
// 供模型作为连续强度使用；分位本身单独保留一列。
function percentileToCenteredZ(percentile) {
  return clamp((percentile - 0.5) * 2, -1, 1)
}

// 从一只股票的 alpha 信号对象抽取决策时点可用的原始量。
// signal 形如 { state, percentile, rawScore, recentRankIc, overallRankIc,
//   scoreMomentum5, asOfDate, generatedAt }。
function readSignal(signal, { expectedDate, maximumAgeMs } = {}) {
  if (!signal || typeof signal !== 'object') return null
  const asOf = dateTimestamp(signal.asOfDate)
  const expected = dateTimestamp(expectedDate)
  const ageMs = asOf != null && expected != null ? expected - asOf : null
  const fresh = (
    signal.state === 'ACTIVE'
    && ageMs != null
    && ageMs >= 0
    && ageMs <= (maximumAgeMs ?? MAX_SNAPSHOT_AGE_MS)
  )
  if (!fresh) return null
  return {
    percentile: finite(signal.percentile),
    recentRankIc: finite(signal.recentRankIc),
    overallRankIc: finite(signal.overallRankIc),
    scoreMomentum5: finite(signal.scoreMomentum5),
  }
}

// 输出与契约同序的 alpha 连续特征块。缺失/过期时全部退化为 0 中性 + Missing=1。
export function alpha158FeatureBlock(signal, options = {}) {
  const s = readSignal(signal, options)
  const pct = s ? s.percentile : null
  const scoreMissing = pct == null || pct < 0 || pct > 1 ? 1 : 0
  const ic20 = s ? s.recentRankIc : null
  const ic60 = s ? s.overallRankIc : null
  const icMissing = ic20 == null && ic60 == null ? 1 : 0
  const mom = s ? s.scoreMomentum5 : null
  const momMissing = mom == null ? 1 : 0

  const values = {
    alphaScoreZ: scoreMissing ? 0 : percentileToCenteredZ(pct),
    alphaScorePctRank: scoreMissing ? 0 : clamp(pct, 0, 1),
    alphaScoreZMissing: scoreMissing,
    alphaRankIc20: ic20 == null ? 0 : clamp(ic20, -1, 1),
    alphaRankIc60: ic60 == null ? 0 : clamp(ic60, -1, 1),
    alphaRankIcMissing: icMissing,
    alphaScoreMomentum5: mom == null ? 0 : clamp(mom, -1, 1),
    alphaScoreMomentumMissing: momMissing,
  }
  // 返回定长数组（与契约同序）+ 命名对象，便于装配 v4 特征向量与断言。
  return {
    schemaVersion: ALPHA158_SIGNAL_FEATURE_VERSION,
    names: ALPHA158_SIGNAL_FEATURE_NAMES,
    vector: ALPHA158_SIGNAL_FEATURE_NAMES.map((name) =>
      Number(Number(values[name]).toFixed(6)),
    ),
    values,
    available: scoreMissing === 0,
  }
}

// 便捷常量：完全缺失时的中性块（用于快照不可用的默认装配）。
export function neutralAlpha158FeatureBlock() {
  return alpha158FeatureBlock(null)
}
