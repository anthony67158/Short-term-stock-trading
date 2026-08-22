export const QUICK_ADVICE_TARGET_MS = 75 * 1000
export const DEEP_ADVICE_TARGET_MS = 8 * 60 * 1000

export function shouldGenerateAdviceDailyReport({
  deepMode = false,
} = {}) {
  return deepMode === true
}

export function shouldRunAdvisorCouncil({
  enabled = true,
  deepMode = false,
  source = 'ondemand',
  councilRequested = false,
} = {}) {
  if (!enabled) return false
  if (councilRequested) return true
  return deepMode === true && source === 'ondemand'
}

export function adviceRequestId(spec = {}, now = Date.now()) {
  const code = String(spec.code || '').trim()
  const mode = String(spec.mode || '').trim()
  const at = Math.max(0, Number(now) || Date.now())
  return `advice:${code}:${mode}:${at}`
}
