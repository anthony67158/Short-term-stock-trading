// 个股「AI 操作建议 + 量化」结果缓存：按股票代码缓存最近一次生成的结果，
// 关闭弹窗再打开、甚至刷新页面（当日内）都能直接看到上次结果，不必重新生成。
const KEY = 'stock_advice_cache_v1'
const TTL = 12 * 3600 * 1000 // 12 小时内有效（跨交易日则视为过期，需重算）

let mem = load()
function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(mem)) } catch { /* ignore */ }
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
}

export function clearAdvice(code) {
  if (code) { delete mem[code] } else { mem = {} }
  persist()
}
