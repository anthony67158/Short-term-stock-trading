// 选股 Agent 精选合同（纯逻辑，可独立单测）。
// 职责：把 LLM 在候选池内的精选结果规范化并逐项复校——只能选输入候选的 code，
// 不得新增股票、不得改排序模型分。买入策略/时机为 Agent 的研判文本，价格边界只能
// 引用候选自身 quote，不允许 Agent 编造执行价。不选时上层展示 Top 候选供参考。

export const STOCK_PICK_AGENT_SCHEMA = 'stock-pick-agent.v1'
export const STOCK_PICK_AGENT_MAX = 3

function clampText(value, maximum = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// 从候选池取 Top N（排序已在 buildStockPickSnapshot 完成），用于"不选"降级展示。
export function topStockPickReferences(snapshot = {}, limit = STOCK_PICK_AGENT_MAX) {
  return (Array.isArray(snapshot.candidates) ? snapshot.candidates : [])
    .slice(0, Math.max(0, limit))
    .map((item) => ({
      code: item.code,
      name: item.name,
      rankingSource: item.ranking?.source || 'RULE',
      rankingScore: finite(item.ranking?.score),
      recallReasons: item.recallReasons || [],
    }))
}

// 规范化 Agent 原始输出。candidateSet 为送入 Agent 的候选（含 code/quote）。
// 任何越界（选了不存在的 code、买入价越出候选当日高低价带）都丢弃该条，绝不放行。
export function normalizeStockPickAgentSelection(raw = {}, {
  candidateSet = [],
  agentModel = '',
  agentRunId = '',
  now = Date.now(),
} = {}) {
  const byCode = new Map(
    (Array.isArray(candidateSet) ? candidateSet : [])
      .filter((item) => /^\d{6}$/.test(String(item?.code || '')))
      .map((item) => [String(item.code), item]),
  )
  const conclusion = raw?.conclusion === 'SELECT' ? 'SELECT' : 'NO_SELECTION'
  const seen = new Set()
  const selections = (Array.isArray(raw?.selections) ? raw.selections : [])
    .map((sel) => {
      const code = String(sel?.code || '')
      const candidate = byCode.get(code)
      if (!candidate || seen.has(code)) return null
      // 买入价必须落在候选当日高低价带内（Agent 不能编造执行价）。
      const low = finite(candidate.quote?.low)
      const high = finite(candidate.quote?.high)
      const price = finite(candidate.quote?.price)
      const buyPrice = finite(sel?.buyStrategy?.entryPrice)
      const bandLow = low ?? price
      const bandHigh = high ?? price
      const entryPrice = (
        buyPrice != null && bandLow != null && bandHigh != null
        && buyPrice >= bandLow * 0.97 && buyPrice <= bandHigh * 1.03
      ) ? buyPrice : (price ?? null)
      if (!clampText(sel?.rationale)) return null
      seen.add(code)
      return {
        code,
        name: candidate.name,
        rank: 0,
        rationale: clampText(sel?.rationale, 200),
        // 买入策略：价格区间 + 仓位上限 + 分批说明（研判文本，不生成成交）。
        buyStrategy: {
          entryPrice,
          positionPctMax: Math.min(
            10,
            Math.max(0, finite(sel?.buyStrategy?.positionPctMax) || 0),
          ),
          plan: clampText(sel?.buyStrategy?.plan, 160),
        },
        // 时机推断：触发条件 + 有效期 + 次日预案（研判文本）。
        timing: {
          trigger: clampText(sel?.timing?.trigger, 160),
          window: clampText(sel?.timing?.window, 80),
          nextSession: clampText(sel?.timing?.nextSession, 160),
        },
        counterCase: clampText(sel?.counterCase, 160),
        invalidation: clampText(sel?.invalidation, 160),
      }
    })
    .filter(Boolean)
    .slice(0, STOCK_PICK_AGENT_MAX)
    .map((item, index) => ({ ...item, rank: index + 1 }))

  return {
    schemaVersion: STOCK_PICK_AGENT_SCHEMA,
    availability: 'READY',
    conclusion: selections.length ? conclusion : 'NO_SELECTION',
    overallReason: clampText(raw?.overallReason, 200),
    selections,
    limitations: (Array.isArray(raw?.limitations) ? raw.limitations : [])
      .map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4),
    agentModel: clampText(agentModel, 120),
    agentRunId: clampText(agentRunId, 80),
    generatedAt: finite(now) || Date.now(),
  }
}

export function unavailableStockPickAgentSelection({
  reasonCode = 'AGENT_UNAVAILABLE',
  reason = '选股 Agent 暂时不可用',
  now = Date.now(),
} = {}) {
  return {
    schemaVersion: STOCK_PICK_AGENT_SCHEMA,
    availability: 'UNAVAILABLE',
    conclusion: 'NO_SELECTION',
    reasonCode: clampText(reasonCode, 60),
    reason: clampText(reason, 200),
    selections: [],
    generatedAt: finite(now) || Date.now(),
  }
}
