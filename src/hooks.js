import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from 'react'
import { api } from './apiBase'

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
  const ctrl = useRef(null)       // 当前在飞的请求 controller —— 组件卸载/切 url 时中止，避免旧响应覆盖新状态
  const alive = useRef(true)      // 组件是否仍挂载：卸载后禁止 setState（防 "state update on unmounted"）
  const tick = useRefreshTick()

  // 底层取数：bust=true 时加时间戳破 CDN 缓存 + 先置 loading（供手动刷新反馈）
  const fetchData = useCallback(async (bust = false) => {
    if (!url) { setData(null); setLoading(false); return }
    if (bust) setLoading(true)
    // 中止上一笔仍在飞的请求，避免慢的旧响应晚到覆盖新数据（竞态）
    if (ctrl.current) { try { ctrl.current.abort() } catch { /* ignore */ } }
    const ac = new AbortController()
    ctrl.current = ac
    try {
      const u = bust ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url
      const res = await fetch(api(u), { cache: bust ? 'no-store' : 'default', signal: ac.signal })
      if (!res.ok) throw new Error('HTTP ' + res.status)   // 先校验状态码，别把 500 的 HTML 当 JSON 解析
      const j = await res.json()
      if (!alive.current || ac.signal.aborted) return       // 已卸载/被中止：丢弃结果，不 setState
      if (j && j.ok === false) {
        setError(j.error || '数据源暂不可用')
      } else {
        setData(j)
        setError(null)
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return               // 主动中止不算错误
      if (!alive.current) return
      setError(String(e.message || e))
    } finally {
      if (alive.current && !ac.signal.aborted) setLoading(false)
    }
    // eslint-disable-next-line
  }, [url])

  const load = useCallback(() => fetchData(false), [fetchData])
  const reload = useCallback(() => fetchData(true), [fetchData]) // 手动刷新：破缓存 + 有 loading 反馈

  useEffect(() => {
    alive.current = true
    if (!url) { setData(null); setLoading(false); return () => { alive.current = false } }
    load()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(load, intervalMs)
    return () => {
      alive.current = false
      if (timer.current) clearInterval(timer.current)
      if (ctrl.current) { try { ctrl.current.abort() } catch { /* ignore */ } }
    }
    // eslint-disable-next-line
  }, [url, intervalMs, tick, ...deps])

  return { data, loading, error, reload }
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
