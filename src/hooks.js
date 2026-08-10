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

export function useMediaQuery(query) {
  const getMatch = () => typeof window !== 'undefined' && window.matchMedia(query).matches
  const [matches, setMatches] = useState(getMatch)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

// 判断当前是否 A 股交易时段
export function isTradingHours() {
  const now = new Date()
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const m = now.getHours() * 60 + now.getMinutes()
  return (m >= 9 * 60 + 15 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60 + 5)
}

// B-7 移动端横滑手势:返回 { bind, dx, swiping }。
//   bind 展开到目标元素的 touch 事件;dx 为实时位移(px,右滑为正);swiping 表示是否正在横滑。
//   —— 触发阈值 threshold(默认 64px):越过后回弹并回调 onLeft(左滑)/onRight(右滑);
//   —— 竖向滚动优先:纵向位移显著大于横向时判为滚动,放弃横滑(不劫持页面滚动);
//   —— 显式按钮保留,手势仅作为快捷补充。
export function useSwipe({ onLeft, onRight, threshold = 64, enabled = true } = {}) {
  const [dx, setDx] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const st = useRef({ x0: 0, y0: 0, active: false, decided: false, horiz: false })

  const reset = () => { setDx(0); setSwiping(false); st.current.active = false; st.current.decided = false; st.current.horiz = false }

  const onTouchStart = useCallback((e) => {
    if (!enabled) return
    const t = e.touches && e.touches[0]
    if (!t) return
    st.current = { x0: t.clientX, y0: t.clientY, active: true, decided: false, horiz: false }
  }, [enabled])

  const onTouchMove = useCallback((e) => {
    if (!enabled || !st.current.active) return
    const t = e.touches && e.touches[0]
    if (!t) return
    const ddx = t.clientX - st.current.x0
    const ddy = t.clientY - st.current.y0
    if (!st.current.decided) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return
      st.current.decided = true
      st.current.horiz = Math.abs(ddx) > Math.abs(ddy) * 1.3 // 横向明显占优才判为横滑
    }
    if (!st.current.horiz) { st.current.active = false; return } // 竖滑 → 交还页面滚动
    // 阻尼:越滑越沉,越界不脱手
    const damped = Math.sign(ddx) * Math.min(Math.abs(ddx), 120) * 0.9
    setDx(damped)
    setSwiping(true)
  }, [enabled])

  const onTouchEnd = useCallback(() => {
    if (!enabled || !st.current.active && !swiping) { reset(); return }
    const d = dx
    if (d <= -threshold && onLeft) onLeft()
    else if (d >= threshold && onRight) onRight()
    reset()
    // eslint-disable-next-line
  }, [enabled, dx, swiping, threshold, onLeft, onRight])

  const bind = enabled ? { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset } : {}
  return { bind, dx, swiping }
}
