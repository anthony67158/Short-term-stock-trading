import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from 'react'

// 全局手动刷新总线：点刷新按钮 → 所有 usePolling 立即重拉
let refreshTick = 0
const refreshListeners = new Set()
export function triggerRefresh() {
  refreshTick++
  refreshListeners.forEach((l) => l())
}
function subscribeRefresh(l) { refreshListeners.add(l); return () => refreshListeners.delete(l) }
export function useRefreshTick() {
  return useSyncExternalStore(subscribeRefresh, () => refreshTick)
}

// 轮询 hook：交易时段自动刷新 + 响应全局手动刷新
export function usePolling(url, intervalMs, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const tick = useRefreshTick()

  const load = useCallback(async () => {
    if (!url) { setData(null); setLoading(false); return } // 无 url 跳过请求
    try {
      const res = await fetch(url)
      const j = await res.json()
      if (j && j.ok === false) {
        setError(j.error || '数据源暂不可用')
      } else {
        setData(j)
        setError(null)
      }
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line
  }, [url])

  useEffect(() => {
    if (!url) { setData(null); setLoading(false); return }
    load()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(load, intervalMs)
    return () => timer.current && clearInterval(timer.current)
    // eslint-disable-next-line
  }, [url, intervalMs, tick, ...deps])

  return { data, loading, error, reload: load }
}

// 全局刷新倒计时：与轮询间隔对齐
export function useCountdown(intervalMs, tick = 0) {
  const [remain, setRemain] = useState(Math.round(intervalMs / 1000))
  useEffect(() => {
    setRemain(Math.round(intervalMs / 1000))
    const id = setInterval(() => {
      setRemain((r) => (r <= 1 ? Math.round(intervalMs / 1000) : r - 1))
    }, 1000)
    return () => clearInterval(id)
  }, [intervalMs, tick])
  return remain
}

// 判断当前是否 A 股交易时段
export function isTradingHours() {
  const now = new Date()
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = now.getHours() * 60 + now.getMinutes()
  return (m >= 9 * 60 + 15 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60 + 5)
}
