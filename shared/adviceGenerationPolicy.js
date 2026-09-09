export const QUICK_ADVICE_TARGET_MS = 55 * 1000
// 深度研判宁可完整等待，也不以提前截断换取表面响应速度。
// 总预算 540s，给唯一模型调用最多 510s，仍在 FC 600s 硬上限内留出收尾时间。
export const DEEP_ADVICE_TARGET_MS = 540 * 1000

export function adviceRequestId(spec = {}, now = Date.now()) {
  const code = String(spec.code || '').trim()
  const mode = String(spec.mode || '').trim()
  const at = Math.max(0, Number(now) || Date.now())
  return `advice:${code}:${mode}:${at}`
}
