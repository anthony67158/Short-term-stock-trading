export const QUICK_ADVICE_TARGET_MS = 75 * 1000
// Compact evidence and bounded reasoning should complete within this window.
// Reserve the remaining FC time for endpoint failover, JSON repair, and OSS publish.
export const DEEP_ADVICE_TARGET_MS = 150 * 1000

export function adviceRequestId(spec = {}, now = Date.now()) {
  const code = String(spec.code || '').trim()
  const mode = String(spec.mode || '').trim()
  const at = Math.max(0, Number(now) || Date.now())
  return `advice:${code}:${mode}:${at}`
}
