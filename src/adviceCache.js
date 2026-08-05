// 个股「AI 操作建议 + 量化」结果缓存：按股票代码缓存最近一次生成的结果，
// 关闭弹窗再打开、甚至刷新页面（当日内）都能直接看到上次结果，不必重新生成。
const KEY = 'stock_advice_cache_v1'
const TTL = 30 * 3600 * 1000 // 30 小时内有效：覆盖「收盘后生成→次日开盘查看」的隔夜跨设备场景,
                             // 让其他设备无需重新生成即可看到最近一轮完整操作建议(每日调度到点会自动重生成刷新)

let mem = load()
function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)) } catch { /* ignore */ }
}

// 轻量订阅：建议刷新时通知（供自选卡片自动跟随「建议买入价/手数」）
const subs = new Set()
export function subscribeAdvice(fn) { subs.add(fn); return () => subs.delete(fn) }
function notify() { subs.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }

// ===== 云端同步：AI 操作建议结果跨设备持久化 =====
// 之前建议结果只存在本机 localStorage，换设备登录就没了、得重新生成(浪费 token)。
// 这里开一个同步回调：建议新增/清除时通知 planStore，随账号数据一起防抖回存云端。
// planStore 登录/切换账号拉到云端数据后调用 setAllAdvice 灌回，实现「手机生成、电脑也能看到」。
let _syncCb = null
export function registerAdviceSync(fn) { _syncCb = fn }
function syncCloud() { try { _syncCb && _syncCb() } catch { /* ignore */ } }

// 导出当前全部有效建议(顺带清掉过期项)，供云端回存
export function getAllAdvice() {
  let changed = false
  for (const k of Object.keys(mem)) {
    if (Date.now() - (mem[k].at || 0) > TTL) { delete mem[k]; changed = true }
  }
  if (changed) persist()
  return mem
}
// 用云端数据整体覆盖本地建议缓存(只收未过期的)；传空对象即清空(登出/切换账号)
export function setAllAdvice(map) {
  if (!map || typeof map !== 'object') return
  const now = Date.now()
  const next = {}
  for (const [k, v] of Object.entries(map)) {
    if (v && (now - (v.at || 0) <= TTL)) next[k] = v
  }
  mem = next
  persist()
  notify()
}

export function getAdvice(code) {
  if (!code) return null
  const e = mem[code]
  if (!e) return null
  if (Date.now() - (e.at || 0) > TTL) { delete mem[code]; persist(); return null }
  return e
}

export function saveAdvice(code, data) {
  if (!code) return
  mem[code] = { ...data, at: Date.now() }
  // 控制体积：最多保留最近 60 只
  const keys = Object.keys(mem)
  if (keys.length > 60) {
    keys.sort((a, b) => (mem[a].at || 0) - (mem[b].at || 0)).slice(0, keys.length - 60)
      .forEach((k) => delete mem[k])
  }
  persist()
  notify()
  syncCloud()
}

export function clearAdvice(code) {
  if (code) { delete mem[code] } else { mem = {} }
  persist()
  notify()
  syncCloud()
}
