export const QUICK_ADVICE_TARGET_MS = 55 * 1000
// 深度研判使用 low 推理 + 精简输出 schema,实测 70-150s 可完成。
// 模型窗口 300s(2x 余量),总预算 360s = 300s 模型 + 60s 数据采集/后处理。
// 受 FC 600s 运行时限制:adviceJobDeadline 约 403s,Worker 启动窗口约 167s,安全。
export const DEEP_ADVICE_TARGET_MS = 360 * 1000

export function adviceRequestId(spec = {}, now = Date.now()) {
  const code = String(spec.code || '').trim()
  const mode = String(spec.mode || '').trim()
  const at = Math.max(0, Number(now) || Date.now())
  return `advice:${code}:${mode}:${at}`
}
