export const QUICK_ADVICE_TARGET_MS = 55 * 1000
// Use the FC runtime window for a complete deep result. The remaining
// minute is reserved for validation, OSS publication, and lease release.
export const DEEP_ADVICE_TARGET_MS = 540 * 1000

export function adviceRequestId(spec = {}, now = Date.now()) {
  const code = String(spec.code || '').trim()
  const mode = String(spec.mode || '').trim()
  const at = Math.max(0, Number(now) || Date.now())
  return `advice:${code}:${mode}:${at}`
}
