// 日内特征提取（从单日分钟线）。
//
// 用于把"首板次日"的进出场做到日内精度：不再裸买开盘，而是看早盘承接、
// 是否站稳 VWAP、竞价/高开强度、分时是否走弱。全部纯函数，无网络。
//
// 输入：某标的某交易日的分钟线（升序，来自 minuteData.normalizeMins），
// 以及可选 prevClose（前一交易日收盘，用于高开幅度）。
// 约定 time 为 'HHMM' 字符串，便于按时段切分。

function finite(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 累计 VWAP 序列：vwap_i = Σamount_{0..i} / Σvol_{0..i}。
// Tushare vol 单位为手(×100股)、amount 为元，比值即元/股，量纲一致。
export function vwapSeries(mins = []) {
  let cumAmt = 0
  let cumVol = 0
  return (Array.isArray(mins) ? mins : []).map((bar) => {
    const amt = finite(bar.amount) ?? 0
    const vol = finite(bar.vol) ?? 0
    cumAmt += amt
    cumVol += vol
    const vwap = cumVol > 0 ? cumAmt / (cumVol * 100) : null
    return { time: bar.time, close: finite(bar.close), vwap: vwap == null ? null : +vwap.toFixed(3) }
  })
}

// 取某时段（含边界）的分钟切片。fromTime/toTime 为 'HHMM'。
export function sliceSession(mins = [], fromTime, toTime) {
  return (Array.isArray(mins) ? mins : []).filter((b) =>
    b.time >= fromTime && b.time <= toTime)
}

// 日内综合特征。openCutoff 之前算"早盘"（默认到 10:00）。
export function intradayFeatures(mins = [], { prevClose = null, openCutoff = '1000' } = {}) {
  const rows = (Array.isArray(mins) ? mins : []).filter((b) => finite(b.close) != null)
  if (!rows.length) return { available: false }

  const first = rows[0]
  const last = rows[rows.length - 1]
  const openPrice = finite(first.open) ?? finite(first.close)
  const closePrice = finite(last.close)
  const pc = finite(prevClose)

  // 高开幅度（相对前收）
  const openGapPct = pc != null && pc > 0 && openPrice != null
    ? +((openPrice - pc) / pc * 100).toFixed(2)
    : null

  // VWAP 序列 + 早盘是否站稳 VWAP
  const vwaps = vwapSeries(rows)
  const early = vwaps.filter((v) => v.time <= openCutoff && v.vwap != null && v.close != null)
  const earlyBelowVwapRatio = early.length
    ? +(early.filter((v) => v.close < v.vwap).length / early.length).toFixed(3)
    : null
  const heldVwapEarly = earlyBelowVwapRatio != null && earlyBelowVwapRatio <= 0.3

  // 分时最高及从高点回撤（尾盘转弱信号）
  const highs = rows.map((b) => finite(b.high)).filter((v) => v != null)
  const intradayHigh = highs.length ? Math.max(...highs) : null
  const pullbackFromHighPct = intradayHigh != null && closePrice != null && intradayHigh > 0
    ? +((intradayHigh - closePrice) / intradayHigh * 100).toFixed(2)
    : null

  // 早盘量能占全天比例（放量攻击 vs 缩量分歧）
  const totalVol = rows.reduce((s, b) => s + (finite(b.vol) ?? 0), 0)
  const earlyVol = sliceSession(rows, first.time, openCutoff)
    .reduce((s, b) => s + (finite(b.vol) ?? 0), 0)
  const earlyVolRatio = totalVol > 0 ? +(earlyVol / totalVol).toFixed(3) : null

  // 收盘相对 VWAP（收在均价上=强）
  const finalVwap = vwaps.length ? vwaps[vwaps.length - 1].vwap : null
  const closeVsVwapPct = finalVwap != null && closePrice != null && finalVwap > 0
    ? +((closePrice - finalVwap) / finalVwap * 100).toFixed(2)
    : null

  return {
    available: true,
    openPrice,
    closePrice,
    openGapPct,
    heldVwapEarly,
    earlyBelowVwapRatio,
    intradayHigh,
    pullbackFromHighPct,
    earlyVolRatio,
    finalVwap,
    closeVsVwapPct,
    vwaps,
  }
}
