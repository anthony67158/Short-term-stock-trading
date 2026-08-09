import { useSyncExternalStore } from 'react'

// 主题：dark(默认) | light，持久化到 localStorage，应用到 <html data-theme>
const KEY = 'theme_v1'
let theme = (() => { try { return localStorage.getItem(KEY) || 'dark' } catch { return 'dark' } })()
const listeners = new Set()

function apply() {
  try { document.documentElement.setAttribute('data-theme', theme) } catch { /* ignore */ }
}
apply()

export const themeStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return theme },
  toggle() {
    theme = theme === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(KEY, theme) } catch { /* ignore */ }
    apply()
    listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } })
  },
}

export function useTheme() {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get)
}
