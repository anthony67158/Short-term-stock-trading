export const QUICK_ADVICE_TARGET_MS = 75 * 1000
// FC hard-stops at 600s. Reserve time for OSS publish and response cleanup
// after the main deep-reasoning request.
export const DEEP_ADVICE_TARGET_MS = 520 * 1000

export function adviceRequestId(spec = {}, now = Date.now()) {
  const code = String(spec.code || '').trim()
  const mode = String(spec.mode || '').trim()
  const at = Math.max(0, Number(now) || Date.now())
  return `advice:${code}:${mode}:${at}`
}
