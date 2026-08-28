// 市场情绪周期引擎（短线择时总开关）。
//
// 短线打法的成败高度依赖市场情绪相位：主升/修复期，打板与接力有溢价；
// 冰点/退潮期，同样的形态大概率亏钱。本模块从每日全市场涨停板数据合成
// 情绪分与相位(regime)，供组合策略作为"总开关"。
//
// 输入：某交易日的 limit_list_d 归一化行（含 limitType U/D/Z、limitTimes 连板次数）。
// 纯函数，无网络、可测试。

function finite(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v))
}

// 单日情绪快照。
export function dailyEmotionSnapshot(limitRows = []) {
  const rows = Array.isArray(limitRows) ? limitRows : []
  const ups = rows.filter((r) => r.limitType === 'U')
  const busts = rows.filter((r) => r.limitType === 'Z') // 炸板
  const downs = rows.filter((r) => r.limitType === 'D') // 跌停
  const upCount = ups.length
  const bustCount = busts.length
  const downCount = downs.length
  const heights = ups.map((r) => finite(r.limitTimes)).filter((v) => v != null)
  const maxHeight = heights.length ? Math.max(...heights) : 0
  const connBoards = heights.filter((h) => h >= 2).length // 连板家数(>=2板)
  // 炸板率 = 炸板 / (涨停 + 炸板)：越高越弱（封不住）。
  const bustRate = upCount + bustCount > 0
    ? bustCount / (upCount + bustCount)
    : null
  return {
    upCount,
    bustCount,
    downCount,
    maxHeight,
    connBoards,
    bustRate: bustRate == null ? null : +bustRate.toFixed(3),
  }
}

// 由单日快照合成情绪分(0-100)。高分=情绪强(利于打板)。
export function emotionScore(snapshot = {}) {
  const up = finite(snapshot.upCount) ?? 0
  const down = finite(snapshot.downCount) ?? 0
  const maxHeight = finite(snapshot.maxHeight) ?? 0
  const connBoards = finite(snapshot.connBoards) ?? 0
  const bustRate = finite(snapshot.bustRate)
  let score = 50
  // 涨停家数：>80 强，<30 弱
  score += clamp((up - 50) / 50 * 25, -25, 25)
  // 跌停家数惩罚
  score -= clamp(down * 1.5, 0, 20)
  // 最高连板高度：赚钱效应龙头
  score += clamp((maxHeight - 3) * 4, -12, 16)
  // 连板家数：梯队厚度
  score += clamp((connBoards - 8) * 1.2, -12, 12)
  // 炸板率惩罚：>0.35 明显走弱
  if (bustRate != null) score -= clamp((bustRate - 0.25) * 80, -8, 25)
  return +clamp(score).toFixed(1)
}

// 相位划分：冰点 / 修复 / 正常 / 高潮 / 退潮。
// 退潮需结合趋势（今天比昨天明显转弱），故传 prevScore。
export function emotionRegime(score, prevScore = null) {
  const s = finite(score)
  if (s == null) return 'UNKNOWN'
  const prev = finite(prevScore)
  const falling = prev != null && s < prev - 10
  if (s >= 72) return falling ? 'EBB' : 'CLIMAX' // 高位快速回落=退潮
  if (s >= 58) return 'RECOVERY_OR_NORMAL'
  if (s >= 42) return falling ? 'EBB' : 'NORMAL'
  return 'FREEZE' // 冰点
}

// 打板/接力是否被情绪允许：修复/正常偏强/高潮允许；冰点/退潮禁止。
export function momentumAllowedByEmotion(regime) {
  return ['RECOVERY_OR_NORMAL', 'CLIMAX', 'NORMAL'].includes(regime)
}

// 从多日 limit 数据构建按日期索引的情绪时间序列。
// limitByDate: { 'YYYYMMDD': [归一化limit行] }
export function buildEmotionSeries(limitByDate = {}) {
  const dates = Object.keys(limitByDate).sort()
  const series = {}
  let prevScore = null
  for (const date of dates) {
    const snap = dailyEmotionSnapshot(limitByDate[date])
    const score = emotionScore(snap)
    const regime = emotionRegime(score, prevScore)
    series[date] = {
      ...snap,
      score,
      regime,
      momentumAllowed: momentumAllowedByEmotion(regime),
    }
    prevScore = score
  }
  return series
}
