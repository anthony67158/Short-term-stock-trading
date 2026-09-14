// 组合层低相关去重（Task12：压回撤）。
//
// 与 shared/lowCorrelationSelection.js 的区别：
//   lowCorrelationSelection 用「概念/板块/打法」标签做 Jaccard 去重，适合有题材
//   标签的生产候选；本模块用「入场前可得的收益路径相关性」（皮尔逊）做去重，
//   适合只有价格/收益序列、没有题材标签的量化回放与组合风控。两者是同一思想
//   （避免一篮子同涨同跌）在不同数据可得性下的实现。
//
// 关键纪律：相关性只能用「入场时点已知」的信息（如过去 N 日收益），绝不能用
// 持有期未来收益，否则是前视。调用方必须传入 trailing（滚动历史）收益向量。
//
// 这是纯选择层：不改任何一笔的动作/价格/手数，只决定「同一时刻的持仓篮子里
// 纳入哪几只」，用于把并发持仓的相关性压到阈值以下，降低集中回撤。

export const PORTFOLIO_CORRELATION_SELECTION_VERSION =
  'portfolio-correlation-selection.v1'

// 皮尔逊相关系数；任一序列无波动或长度不足时返回 0（视为不相关，交由容量约束兜底）。
export function pearsonCorrelation(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i += 1) {
    const x = Number(a[i])
    const y = Number(b[i])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    sa += x
    sb += y
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i += 1) {
    const dx = Number(a[i]) - ma
    const dy = Number(b[i]) - mb
    num += dx * dy
    da += dx * dx
    db += dy * dy
  }
  if (da <= 0 || db <= 0) return 0
  const r = num / Math.sqrt(da * db)
  if (!Number.isFinite(r)) return 0
  return Math.max(-1, Math.min(1, r))
}

// 贪心低相关选择：按传入顺序（调用方已按分数排好）逐个尝试纳入当前持仓篮子。
// 若候选与已选中任一持仓的收益相关性超过 maxCorrelation，或达到 maxHoldings，则跳过。
// held: 已在场的持仓 [{ key, returns }]（可为空）；candidates: 待纳入候选 [{ key, returns, ... }]。
// 返回被接受的候选（保留原对象）与逐条 skip 原因，便于审计与统计有效机会数。
export function selectLowCorrelationBook(
  candidates = [],
  held = [],
  {
    maxCorrelation = 0.7,
    maxHoldings = Infinity,
    roomForNew = Infinity,
  } = {},
) {
  const accepted = []
  const skipped = []
  // 已在场持仓的收益向量参与相关性判定，但不占用 roomForNew。
  const book = (Array.isArray(held) ? held : [])
    .filter((h) => h && Array.isArray(h.returns))
    .map((h) => ({ key: h.key, returns: h.returns }))
  const totalCap = Number.isFinite(maxHoldings) ? maxHoldings : Infinity

  for (const cand of Array.isArray(candidates) ? candidates : []) {
    if (book.length >= totalCap) {
      skipped.push({ key: cand?.key, reason: 'BOOK_FULL' })
      continue
    }
    if (accepted.length >= roomForNew) {
      skipped.push({ key: cand?.key, reason: 'NEW_CAPACITY_FULL' })
      continue
    }
    const returns = Array.isArray(cand?.returns) ? cand.returns : null
    if (!returns) {
      // 无相关性依据时，保守起见仍允许纳入（相关性未知不等于高相关），
      // 但标注，方便统计缺口。
      accepted.push(cand)
      book.push({ key: cand?.key, returns: [] })
      skipped.push({ key: cand?.key, reason: 'NO_RETURNS_ACCEPTED' })
      continue
    }
    let maxSeen = 0
    let clash = false
    for (const entry of book) {
      if (!entry.returns.length) continue
      const r = Math.abs(pearsonCorrelation(returns, entry.returns))
      if (r > maxSeen) maxSeen = r
      if (r > maxCorrelation) {
        clash = true
        break
      }
    }
    if (clash) {
      skipped.push({
        key: cand?.key,
        reason: 'HIGH_CORRELATION',
        correlation: Number(maxSeen.toFixed(4)),
      })
      continue
    }
    accepted.push(cand)
    book.push({ key: cand?.key, returns })
  }

  return {
    schemaVersion: PORTFOLIO_CORRELATION_SELECTION_VERSION,
    accepted,
    skipped,
    acceptedCount: accepted.length,
    bookSize: book.length,
  }
}
