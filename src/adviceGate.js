// 「单股 AI 操作建议」触发门控层。
// 落实设计规则:
//   规则1(并发绑定端点数):同一时刻正在生成的股票数 ≤ 用户配置的 AI 端点数(承接 advisor 角色)。
//                          上限来自服务端权威值,经 adviceBatch.getConcurrency() 拿到(云端回灌/首屏预置)。
//   规则2(全局共享 & 不重复触发):同一只已在生成 → 不再重复触发,直接复用进度(UI 照常订阅展示)。
// 触发逻辑(以 2 个端点为例):
//   · 依次点 A、B(端点空闲)→ 直接并行启动;
//   · 再点 C(端点已满)→ 返回 { status:'full', busy:[{code,name}] },由 UI 弹「端点已满 + 正在生成清单」,
//     清单项可点击跳转到对应个股。
//
// 「占用 advisor」的口径 = 本地 runner 正在跑的 ∪ 服务端 advisorBusy:
//   本机点击既可能走本地生成,也可能兜底走服务端;另一台设备的服务端生成也占用同一批端点。
//   review 任务独立占用 review 端点，不能阻塞新的主建议。
import { startAdvice, getRunningList, isRunning } from './adviceRunner'
import { getBatchState, getConcurrency } from './adviceBatch'
import { canServerAdvice, triggerServerAdvice } from './serverAdvice'
import {
  adviceJobState,
  startAdvicePersistently,
} from '../shared/adviceUiState.js'

// 汇总当前"正在生成"的股票:code -> name(本地 + 云端并集)。
export function generatingList() {
  const map = new Map()
  // 本地正在跑
  try { for (const it of getRunningList()) if (it && it.code) map.set(String(it.code), it.name || it.code) } catch { /* ignore */ }
  // 服务端正在跑(current=running 的 code;items 里带 name)
  try {
    const bs = getBatchState()
    const nameOf = new Map((bs.items || []).map((x) => [String(x.code), x.name || x.code]))
    const busyCodes = Array.isArray(bs.advisorBusy)
      ? bs.advisorBusy
      : bs.current || []
    for (const c of busyCodes) { const code = String(c); if (!map.has(code)) map.set(code, nameOf.get(code) || code) }
  } catch { /* ignore */ }
  return [...map.entries()].map(([code, name]) => ({ code, name }))
}

// 某只是否正在生成(本地或云端)。
export function isGenerating(code) {
  if (!code) return false
  const c = String(code)
  if (isRunning(c)) return true
  try { return !!adviceJobState(getBatchState(), c)?.active } catch { return false }
}

// 门控式触发。返回:
//   { status:'started' }        —— 已启动本次生成
//   { status:'already' }        —— 该股已在生成中(不重复触发,UI 直接看进度)
//   { status:'full', busy:[{code,name}], concurrency } —— 端点已满,附正在生成的清单
export async function tryStartAdvice(spec) {
  const code = spec && spec.code
  if (!code) return { status: 'started' }   // 无 code 交给底层自行忽略
  // 规则2:同一只已在生成 → 不重复触发
  if (isGenerating(code)) {
    return {
      status: 'already',
      mode: isRunning(String(code)) ? 'local' : 'server',
      code: String(code),
    }
  }
  // 规则1:占用端点数(排除当前这只)达到并发上限 → 端点已满
  const busy = generatingList().filter((x) => x.code !== String(code))
  const limit = getConcurrency()
  if (busy.length >= limit) return { status: 'full', busy, concurrency: limit }
  return await startAdvicePersistently(spec, {
    canUseServer: canServerAdvice,
    triggerServer: triggerServerAdvice,
    startLocal: startAdvice,
  })
}
