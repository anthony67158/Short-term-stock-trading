import {
  DEEP_ADVICE_TARGET_MS,
  QUICK_ADVICE_TARGET_MS,
} from './adviceGenerationPolicy.js'

export const DEEP_BATCH_CONCURRENCY = 2
export const QUICK_ADVICE_BUDGET_MS = QUICK_ADVICE_TARGET_MS
export const DEEP_ADVICE_BUDGET_MS = DEEP_ADVICE_TARGET_MS

export function validateBatchMode(codes = [], deepMode = false) {
  const count = new Set((codes || []).filter(Boolean).map(String)).size
  if (!count) return { ok: false, error: 'empty' }
  return { ok: true, count, deepMode: !!deepMode }
}

export function batchConcurrency(endpointCount, deepMode = false) {
  const available = Math.max(1, Number(endpointCount) || 1)
  return deepMode ? Math.min(DEEP_BATCH_CONCURRENCY, available) : available
}

export function adviceConcurrency(
  endpointCount,
  {
    deepMode = false,
    batchRequest = false,
  } = {},
) {
  const available = Math.max(1, Number(endpointCount) || 1)
  return batchRequest
    ? batchConcurrency(available, deepMode)
    : available
}

const text = (value) => String(value || '').trim()

export function adviceCompleteness(advice, mode = '') {
  const value = advice && typeof advice === 'object' ? advice : {}
  const contract = value.knowledgeActionPlan
    && typeof value.knowledgeActionPlan === 'object'
    ? value.knowledgeActionPlan
    : {}
  const action = text(value.action || value.stance)
  const title = text(value.title || value.headline)
  const primaryInstruction = mode === 'review'
    ? value.nextAction || value.actionPlan
    : value.actionPlan || value.nextAction
  const instruction = text(
    primaryInstruction
    || value.timing
    || contract.executionPlan,
  )
  const invalidation = text(
    value.invalidation
    || contract.invalidation,
  )
  const evidenceCount = [
    value.quantNote,
    value.fundNote,
    value.techNote,
    value.newsNote,
    value.intradayNote,
    value.macroNote,
  ].filter((item) => text(item)).length
  const terminalTriggeredReview =
    value.reviewDecision?.schemaVersion
      === 'triggered-review-decision.v1'
    && value.reviewDecision?.terminal === true
  const missing = []
  if (!action) missing.push('动作结论')
  if (!title) missing.push('标题')
  if (!instruction) missing.push('执行指令')
  if (!invalidation) missing.push('失效条件')
  // 触价复核是限时终局判断：至少一类可追溯依据即可决断，
  // 不再为了凑两类证据拖延或重新生成观察价。
  if (evidenceCount < (terminalTriggeredReview ? 1 : 2)) {
    missing.push('核心依据')
  }
  const requiresShortExitPlan = (
    mode === 'hold_advice'
    || (
      mode === 'buy_advice'
      && /立即买入|回调再买|小仓试错|买入/.test(action)
    )
  )
  if (requiresShortExitPlan) {
    if (!text(value.nextOpenPlan)) missing.push('次日应对')
    if (!text(value.futurePlan)) missing.push('五日内退出路径')
  }
  return {
    complete: missing.length === 0,
    missing,
  }
}

export function completeAdviceHorizonFields(advice, mode = '') {
  if (!advice || typeof advice !== 'object' || advice.raw) return advice
  const action = text(advice.action || advice.stance)
  const requiresPlan = (
    mode === 'hold_advice'
    || (
      mode === 'buy_advice'
      && /立即买入|回调再买|小仓试错|买入/.test(action)
    )
  )
  if (!requiresPlan) return advice
  return {
    ...advice,
    nextOpenPlan: text(advice.nextOpenPlan) || (
      mode === 'hold_advice'
        ? '高开按目标或减仓条件执行，平开继续核对量价，低开优先守止损条件。'
        : '高开不追涨，平开等待买点与量能确认，低开先观察止跌；条件未满足不下单。'
    ),
    futurePlan: text(advice.futurePlan) || (
      mode === 'hold_advice'
        ? '未来1-5日只按当前止损、减仓和目标条件执行，逻辑失效及时退出。'
        : '成交后1-5日按止损与目标条件管理；未成交则不买入，且不提高买价。'
    ),
  }
}

export function isCompleteAdviceEntry(entry, expectedMode = '') {
  if (!entry || typeof entry !== 'object') return false
  if (entry.truncated === true || entry.advice?.truncated === true) return false
  const mode = expectedMode || entry.mode || ''
  return adviceCompleteness(entry.advice, mode).complete
}

export function acceptsGenerationResult(result, mode = '') {
  if (result?.unchanged === true) return true
  if (result?.truncated === true) return false
  return adviceCompleteness(result?.advice, mode).complete
}

export function generationOptions(deepMode = false) {
  return deepMode
    ? {
        deepMode: true,
        fastMode: false,
        forceReasoning: true,
        runtimeBudgetMs: DEEP_ADVICE_BUDGET_MS,
        timeoutMs: DEEP_ADVICE_BUDGET_MS + 15000,
        maxAttempts: 1,
      }
    : {
        deepMode: false,
        fastMode: true,
        forceReasoning: false,
        runtimeBudgetMs: QUICK_ADVICE_BUDGET_MS,
        timeoutMs: QUICK_ADVICE_BUDGET_MS + 15000,
        maxAttempts: 1,
      }
}

export function createAdviceSubmissionRegistry() {
  const pending = new Map()
  const listeners = new Set()
  const notify = () => {
    for (const listener of listeners) {
      try { listener() } catch { /* 状态订阅不能阻断提交 */ }
    }
  }
  return {
    begin(code, name = '', details = {}) {
      const key = String(code || '')
      if (!key || pending.has(key)) return false
      pending.set(key, {
        code: key,
        name: String(name || key),
        ...(details && typeof details === 'object' ? details : {}),
      })
      notify()
      return true
    },
    update(code, patch = {}) {
      const key = String(code || '')
      const current = pending.get(key)
      if (!current) return false
      pending.set(key, {
        ...current,
        ...(patch && typeof patch === 'object' ? patch : {}),
        code: key,
      })
      notify()
      return true
    },
    end(code) {
      if (pending.delete(String(code || ''))) notify()
    },
    has(code) {
      return pending.has(String(code || ''))
    },
    get(code) {
      const item = pending.get(String(code || ''))
      return item ? { ...item } : null
    },
    list() {
      return [...pending.values()].map((item) => ({ ...item }))
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clear() {
      if (!pending.size) return
      pending.clear()
      notify()
    },
  }
}
