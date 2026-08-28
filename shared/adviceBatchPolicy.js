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
        maxAttempts: 2,
      }
}
