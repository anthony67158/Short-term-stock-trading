// 「盘中定时刷新 AI 操作建议」调度器。
// 交易期间数据实时变化,用户可设定一个后台定时任务:每隔 N 分钟,对选定范围(自选/持仓)
// 的股票批量重生成 AI 操作建议,让操作指导始终对齐最新盘面。
// 设计要点:
//   1) 完全复用 adviceBatch.runBatchAdvice —— 与手动「一次性生成」/每日定时同源,保证建议的连续性与一致性。
//   2) 配置(开关/间隔分钟/范围)走 planStore.setSetting/getSetting,跨设备云端同步。
//   3) 只在交易时段(集合竞价+连续竞价)触发,收盘/休市不空跑,省算力与网关配额。
//   4) 单例节流:到点且距上次刷新已满一个间隔才跑;正在批量跑则跳过本次(不重入)。
//   5) 记录「最近一次刷新时间」到 setting,供前端展示。
import { planStore, computePortfolio } from './planStore'
import { runBatchAdvice, isBatchRunning } from './adviceBatch'
import { isWeekday, bjMinutes } from './review'

// ===== 设置键(跨设备云端同步) =====
export const K_ENABLED = 'advAuto.enabled'    // bool 是否开启定时刷新
export const K_INTERVAL = 'advAuto.intervalMin' // number 刷新间隔(分钟)
export const K_SCOPE = 'advAuto.scope'        // 'watch' | 'hold' | 'both'
export const K_LAST = 'advAuto.lastAt'        // number 最近一次刷新完成时间戳(ms)
export const K_LASTTRY = 'advAuto.lastTryAt'  // number 最近一次「发起」时间戳(用于间隔判定)

export const DEFAULT_INTERVAL = 15            // 默认 15 分钟
export const MIN_INTERVAL = 1                 // 最短 1 分钟(防误触打爆网关)
export const MAX_INTERVAL = 240               // 最长 4 小时

// 读配置(带默认值 & 边界修正)
export function getAutoConfig() {
  const enabled = !!planStore.getSetting(K_ENABLED, false)
  let intervalMin = Number(planStore.getSetting(K_INTERVAL, DEFAULT_INTERVAL))
  if (!Number.isFinite(intervalMin) || intervalMin < MIN_INTERVAL) intervalMin = MIN_INTERVAL
  if (intervalMin > MAX_INTERVAL) intervalMin = MAX_INTERVAL
  let scope = planStore.getSetting(K_SCOPE, 'both')
  if (scope !== 'watch' && scope !== 'hold' && scope !== 'both') scope = 'both'
  const lastAt = Number(planStore.getSetting(K_LAST, 0)) || 0
  const lastTryAt = Number(planStore.getSetting(K_LASTTRY, 0)) || 0
  return { enabled, intervalMin, scope, lastAt, lastTryAt }
}

// 是否处于「可刷新的交易时段」:交易日 09:15(集合竞价尾段)~ 15:00。
// 盘中数据才有实时变化的价值;非交易时段不空跑。
function inRefreshWindow() {
  if (!isWeekday()) return false
  const hm = bjMinutes()
  return hm >= 555 && hm <= 900  // 09:15 ~ 15:00
}

// 按范围取要刷新的股票代码集合
function codesForScope(scope) {
  const st = planStore.get()
  const holding = st.holding || []
  const watch = st.plan || []
  const holdCodes = [...new Set(holding.map((h) => h.code))]
  const holdSet = new Set(holdCodes)
  // 自选排除已持仓(避免同股两套 mode 冲突,持仓优先 hold_advice)
  const watchCodes = [...new Set(watch.map((w) => w.code))].filter((c) => !holdSet.has(c))
  if (scope === 'hold') return holdCodes
  if (scope === 'watch') return watchCodes
  return [...new Set([...holdCodes, ...watchCodes])]
}

let _running = false
// 定时刷新入口:由 App.jsx 的分钟级调度器调用(与 runDailyAdviceIfDue 并列)。
// quoteMap: {code:{price,...}} 供算浮盈亏/账户仓位。
// 触发条件:①已开启 ②处于交易时段 ③距上次「发起」已满一个间隔 ④当前无批量任务在跑。
export async function runAutoRefreshIfDue(quoteMap) {
  if (_running) return false
  const cfg = getAutoConfig()
  if (!cfg.enabled) return false
  if (!inRefreshWindow()) return false
  if (isBatchRunning()) return false
  const now = Date.now()
  const gapMs = cfg.intervalMin * 60 * 1000
  if (cfg.lastTryAt && (now - cfg.lastTryAt) < gapMs) return false

  const codes = codesForScope(cfg.scope)
  if (!codes.length) return false

  _running = true
  // 先记「发起时间」——即便本轮批量较慢,也不会在下一分钟重复发起
  planStore.setSetting(K_LASTTRY, now)
  try {
    const ok = await runBatchAdvice(codes, quoteMap || {})
    if (ok) planStore.setSetting(K_LAST, Date.now())
    return ok
  } finally {
    _running = false
  }
}
