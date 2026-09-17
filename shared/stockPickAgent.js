// 选股 Agent 精选合同（纯逻辑，可独立单测）。
// 职责：把 LLM 在候选池内的精选结果规范化并逐项复校——只能选输入候选的 code，
// 不得新增股票、不得改排序模型分。买入策略/时机为 Agent 的研判文本，价格边界只能
// 引用候选自身 quote，不允许 Agent 编造执行价。不选时上层展示 Top 候选供参考。
import {
  STOCK_PICK_MODE,
  normalizeStockPickMode,
} from './stockPickModes.js'

export const STOCK_PICK_AGENT_SCHEMA = 'stock-pick-agent.v2'
export const STOCK_PICK_AGENT_MAX = 3

export const STOCK_PICK_DECISION = Object.freeze({
  BUY_NOW: 'BUY_NOW',
  WAIT_TRIGGER: 'WAIT_TRIGGER',
  LAYOUT_SMALL: 'LAYOUT_SMALL',
  WATCH_NEXT_DAY: 'WATCH_NEXT_DAY',
  REJECT: 'REJECT',
})

const DECISION_SET = new Set(Object.values(STOCK_PICK_DECISION))

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
  mode = STOCK_PICK_MODE.INTRADAY,
  trigger = 'MANUAL',
  toolTrace = [],
  toolEvidence = [],
  now = Date.now(),
} = {}) {
  const normalizedMode = normalizeStockPickMode(mode)
  const quoteByCode = new Map(
    (Array.isArray(toolEvidence) ? toolEvidence : [])
      .filter((item) =>
        item?.tool === 'stock_quote'
        && item?.ok === true
        && /^\d{6}$/.test(String(item?.code || ''))
      )
      .map((item) => [String(item.code), item.result || {}]),
  )
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
      let decision = DECISION_SET.has(sel?.decision)
        ? sel.decision
        : STOCK_PICK_DECISION.WAIT_TRIGGER
      if (
        normalizedMode === STOCK_PICK_MODE.NEXT_DAY
        && trigger === 'INITIAL'
      ) {
        decision = STOCK_PICK_DECISION.WATCH_NEXT_DAY
      }
      const verifiedQuote = quoteByCode.get(code)
      if (
        normalizedMode === STOCK_PICK_MODE.INTRADAY
        && decision === STOCK_PICK_DECISION.BUY_NOW
        && verifiedQuote?.isLivePrice !== true
      ) {
        decision = STOCK_PICK_DECISION.WAIT_TRIGGER
      }
      if (
        normalizedMode === STOCK_PICK_MODE.NEXT_DAY
        && trigger === 'FIRST_QUOTE'
        && verifiedQuote?.isLivePrice !== true
      ) return null
      seen.add(code)
      return {
        code,
        name: candidate.name,
        rank: 0,
        decision,
        rationale: clampText(sel?.rationale, 200),
        // 买入策略：价格区间 + 仓位上限 + 分批说明（研判文本，不生成成交）。
        buyStrategy: {
          entryPrice,
          positionPctMax: Math.min(
            normalizedMode === STOCK_PICK_MODE.EARLY_LAYOUT ? 5 : 10,
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
        evidence: (Array.isArray(sel?.evidence) ? sel.evidence : [])
          .map((item) => ({
            tool: clampText(item?.tool, 60),
            summary: clampText(item?.summary, 160),
          }))
          .filter((item) => item.tool && item.summary)
          .slice(0, 6),
        // T+1 是服务端固定约束，不接受模型覆盖。
        t1Plan: {
          earliestSell: 'NEXT_TRADING_DAY',
          rule: 'A股普通股票买入当日不可卖出',
          overnightRisk: clampText(sel?.t1Plan?.overnightRisk, 160)
            || '需承担买入日至下一交易日可卖前的隔夜风险',
          nextDayAction: clampText(sel?.t1Plan?.nextDayAction, 160)
            || clampText(sel?.timing?.nextSession, 160),
        },
      }
    })
    .filter(Boolean)
    .slice(0, STOCK_PICK_AGENT_MAX)
    .map((item, index) => ({ ...item, rank: index + 1 }))

  return {
    schemaVersion: STOCK_PICK_AGENT_SCHEMA,
    availability: 'READY',
    mode: normalizedMode,
    trigger: clampText(trigger, 40) || 'MANUAL',
    conclusion: selections.length ? conclusion : 'NO_SELECTION',
    overallReason: clampText(raw?.overallReason, 200),
    stageAssessment: clampText(raw?.stageAssessment, 240),
    selections,
    limitations: (Array.isArray(raw?.limitations) ? raw.limitations : [])
      .map((item) => clampText(item, 120)).filter(Boolean).slice(0, 4),
    agentModel: clampText(agentModel, 120),
    agentRunId: clampText(agentRunId, 80),
    toolTrace: (Array.isArray(toolTrace) ? toolTrace : [])
      .map((item) => ({
        tool: clampText(item?.tool, 60),
        code: clampText(item?.code, 12),
        ok: item?.ok === true,
        summary: clampText(item?.summary, 160),
      }))
      .filter((item) => item.tool)
      .slice(0, 24),
    generatedAt: finite(now) || Date.now(),
  }
}

export function unavailableStockPickAgentSelection({
  reasonCode = 'AGENT_UNAVAILABLE',
  reason = '选股 Agent 暂时不可用',
  mode = STOCK_PICK_MODE.INTRADAY,
  trigger = 'MANUAL',
  agentRunId = '',
  toolTrace = [],
  now = Date.now(),
} = {}) {
  return {
    schemaVersion: STOCK_PICK_AGENT_SCHEMA,
    availability: 'UNAVAILABLE',
    mode: normalizeStockPickMode(mode),
    trigger: clampText(trigger, 40) || 'MANUAL',
    conclusion: 'NO_SELECTION',
    reasonCode: clampText(reasonCode, 60),
    reason: clampText(reason, 200),
    selections: [],
    agentRunId: clampText(agentRunId, 80),
    toolTrace: (Array.isArray(toolTrace) ? toolTrace : [])
      .map((item) => ({
        tool: clampText(item?.tool, 60),
        code: clampText(item?.code, 12),
        ok: item?.ok === true,
        summary: clampText(item?.summary, 160),
      }))
      .filter((item) => item.tool)
      .slice(0, 24),
    generatedAt: finite(now) || Date.now(),
  }
}
