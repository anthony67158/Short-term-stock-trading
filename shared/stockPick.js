// 选股模块合同（纯逻辑，可独立单测）：候选、召回快照、可用性降级。
// 三层：召回(全市场扫描+因子/规则) → 排序(离线模型分或规则召回分) → Agent 精选。
// 硬约束：市场事实/模型分/Agent 研判分开保存；缺失明确不可用，不用旧分伪装。

export const STOCK_PICK_SCHEMA_VERSION = 'stock-pick.v1'
export const STOCK_PICK_MAX_CANDIDATES = 24
export const STOCK_PICK_AGENT_MAX_SELECTIONS = 3

export const RANKING_SOURCE = Object.freeze({
  MODEL: 'MODEL', // 离线发布的排序模型分
  RULE: 'RULE', // 模型缺失时的可解释规则召回分
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clampText(value, maximum = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

// 规则召回分：可解释、非模型预测。仅用量价/资金公开事实，产出 0~100 相对分与理由。
// 不得声称为收益预测，仅表达"当前形态相对强度"。
export function ruleRecallScore(row = {}) {
  const pct = finite(row.pct)
  const amount = finite(row.amount)
  const turnover = finite(row.turnover)
  const volumeRatio = finite(row.volumeRatio)
  const mainRatio = finite(row.mainRatio)
  const price = finite(row.price)
  const high = finite(row.high)
  const low = finite(row.low)
  const reasons = []
  let score = 0

  if (pct != null && pct > 0) {
    score += Math.min(20, pct * 3)
    reasons.push(`当日涨幅 ${pct.toFixed(2)}%`)
  }
  if (volumeRatio != null && volumeRatio >= 1) {
    score += Math.min(20, (volumeRatio - 1) * 12)
    reasons.push(`量比 ${volumeRatio.toFixed(2)}`)
  }
  if (turnover != null && turnover >= 3) {
    score += Math.min(15, turnover)
    reasons.push(`换手 ${turnover.toFixed(2)}%`)
  }
  if (amount != null) {
    const yi = amount / 1e8
    if (yi >= 1) {
      score += Math.min(15, yi * 1.5)
      reasons.push(`成交额 ${yi.toFixed(2)}亿`)
    }
  }
  if (mainRatio != null && mainRatio > 0) {
    score += Math.min(20, mainRatio)
    reasons.push(`主力净占比 ${mainRatio.toFixed(2)}%`)
  }
  // 位置：贴近当日高点为强，靠近低点扣分（追高风险由 Agent 复核）。
  if (price != null && high != null && low != null && high > low) {
    const location = (price - low) / (high - low)
    if (location >= 0.5) {
      score += Math.min(10, (location - 0.5) * 20)
    }
  }
  return {
    score: Math.max(0, Math.min(100, +score.toFixed(2))),
    reasons: reasons.slice(0, 5),
  }
}

// 归一化单个候选：只保留可追溯的公开字段 + 规则分/理由 + 可选模型分。
export function normalizeStockPickCandidate(row = {}, { modelScore = null } = {}) {
  const recall = ruleRecallScore(row)
  const model = modelScore && modelScore.state === 'READY'
    ? {
        state: 'READY',
        rankingScore: finite(modelScore.rankingScore),
        pFill: finite(modelScore.pFill),
        pWinGivenFill: finite(modelScore.pWinGivenFill),
        expectedNetR: finite(modelScore.expectedNetR),
        modelVersion: clampText(modelScore.modelVersion, 120),
      }
    : null
  return {
    code: clampText(row.code, 12),
    name: clampText(row.name, 60),
    industry: clampText(row.industry, 60),
    quote: {
      price: finite(row.price),
      pct: finite(row.pct),
      amount: finite(row.amount),
      turnover: finite(row.turnover),
      volumeRatio: finite(row.volumeRatio),
      mainInflow: finite(row.mainInflow),
      mainRatio: finite(row.mainRatio),
      tradeDate: clampText(row.tradeDate, 16),
    },
    recallScore: recall.score,
    recallReasons: recall.reasons,
    model,
    // 排序分优先取模型分，缺失回落规则分并标注来源。
    ranking: model?.rankingScore != null
      ? { source: RANKING_SOURCE.MODEL, score: model.rankingScore }
      : { source: RANKING_SOURCE.RULE, score: recall.score },
  }
}

// 按排序分降序，模型分与规则分不混排（模型候选整体优先）。
export function rankStockPickCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    const leftModel = left.ranking?.source === RANKING_SOURCE.MODEL ? 1 : 0
    const rightModel = right.ranking?.source === RANKING_SOURCE.MODEL ? 1 : 0
    if (leftModel !== rightModel) return rightModel - leftModel
    return (right.ranking?.score || 0) - (left.ranking?.score || 0)
  })
}

export function buildStockPickSnapshot({
  candidates = [],
  total = 0,
  inspected = 0,
  tradeDate = '',
  rankingSource = RANKING_SOURCE.RULE,
  modelVersion = '',
  now = Date.now(),
} = {}) {
  const ranked = rankStockPickCandidates(candidates)
    .slice(0, STOCK_PICK_MAX_CANDIDATES)
  return {
    schemaVersion: STOCK_PICK_SCHEMA_VERSION,
    availability: ranked.length ? 'READY' : 'EMPTY',
    tradeDate: clampText(tradeDate, 16),
    universe: { total: finite(total) || 0, inspected: finite(inspected) || 0 },
    rankingSource,
    modelVersion: clampText(modelVersion, 120),
    candidates: ranked,
    generatedAt: finite(now) || Date.now(),
  }
}

export function unavailableStockPickSnapshot({
  reasonCode = 'RECALL_UNAVAILABLE',
  reason = '选股召回暂时不可用',
  tradeDate = '',
  now = Date.now(),
} = {}) {
  return {
    schemaVersion: STOCK_PICK_SCHEMA_VERSION,
    availability: 'UNAVAILABLE',
    reasonCode: clampText(reasonCode, 60),
    reason: clampText(reason, 200),
    tradeDate: clampText(tradeDate, 16),
    universe: { total: 0, inspected: 0 },
    candidates: [],
    generatedAt: finite(now) || Date.now(),
  }
}
