export const DEEP_BATCH_CONCURRENCY = 2
export const QUICK_ADVICE_BUDGET_MS = 120000
export const DEEP_ADVICE_BUDGET_MS = 480000

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

export function acceptsGenerationResult(result, deepMode = false) {
  if (!deepMode) return !!(result?.advice || result?.quant || result?.unchanged)
  return !!result?.advice && result.truncated !== true
}

export function generationOptions(deepMode = false) {
  return deepMode
    ? {
        deepMode: true,
        fastMode: false,
        forceReasoning: true,
        runtimeBudgetMs: DEEP_ADVICE_BUDGET_MS,
        timeoutMs: DEEP_ADVICE_BUDGET_MS + 15000,
        maxAttempts: 3,
      }
    : {
        deepMode: false,
        fastMode: true,
        forceReasoning: false,
        runtimeBudgetMs: QUICK_ADVICE_BUDGET_MS,
        timeoutMs: QUICK_ADVICE_BUDGET_MS + 15000,
        maxAttempts: 3,
      }
}
