import { useSyncExternalStore } from 'react'
import { planStore } from './planStore'

// ============ 云端账号体系（Vercel Blob 持久化，跨设备同步）============
// 会话（昵称+密码）持久化在本机 localStorage，保持长期登录（关标签页/切后台不掉线）；数据存云端。
const SESS = 'cloud_session_v1'
const LEGACY_KEY = 'trade_book_v2' // 旧的无账号本机数据(供首次注册导入)

function loadSession() {
  try {
    let raw = localStorage.getItem(SESS)
    // 兼容旧版本存在 sessionStorage 的会话：迁移到 localStorage，避免掉线
    if (!raw) {
      const legacy = sessionStorage.getItem(SESS)
      if (legacy) { localStorage.setItem(SESS, legacy); sessionStorage.removeItem(SESS); raw = legacy }
    }
    return JSON.parse(raw || 'null')
  } catch { return null }
}
function saveSession(s) {
  try {
    if (s) localStorage.setItem(SESS, JSON.stringify(s))
    else { localStorage.removeItem(SESS); sessionStorage.removeItem(SESS) }
  } catch { /* ignore */ }
}

let state = {
  user: null,        // 昵称
  status: 'idle',    // idle | loading | ready | error
  error: '',
  booting: true,     // 启动时是否在恢复会话
}
const listeners = new Set()
function emit() { state = { ...state }; listeners.forEach((l) => l()) }

let _pw = null // 密码仅保存在内存 + sessionStorage，用于后续保存

// 读取本机旧数据（首次注册可导入）
export function readLegacyData() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (d && ((d.plan && d.plan.length) || (d.holding && d.holding.length) || (d.closed && d.closed.length))) {
      return { plan: d.plan || [], holding: d.holding || [], closed: d.closed || [] }
    }
    return null
  } catch { return null }
}
export function hasLegacyData() { return !!readLegacyData() }

async function api(action, payload) {
  const r = await fetch('/api/account', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const raw = await r.text()
  try { return JSON.parse(raw) } catch { return { ok: false, error: `服务异常(${r.status})` } }
}

export const authStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },

  // 启动时尝试用 sessionStorage 里的会话恢复登录并拉云端数据
  async boot() {
    const s = loadSession()
    if (!s || !s.nick) { state.booting = false; emit(); return }
    _pw = s.pw
    const r = await api('get', { nick: s.nick, pw: s.pw })
    if (r.ok) {
      state.user = s.nick; state.status = 'ready'
      planStore.setData(r.data)
    } else {
      saveSession(null); _pw = null
    }
    state.booting = false; emit()
  },

  async register(nick, pw, importLegacy = false) {
    nick = String(nick || '').trim()
    if (!nick) return { ok: false, error: '请输入昵称' }
    if (!pw) return { ok: false, error: '请输入密码' }
    state.status = 'loading'; state.error = ''; emit()
    const data = importLegacy ? (readLegacyData() || { plan: [], holding: [], closed: [] }) : { plan: [], holding: [], closed: [] }
    const r = await api('register', { nick, pw, data })
    if (!r.ok) { state.status = 'error'; state.error = r.error; emit(); return r }
    _pw = String(pw); saveSession({ nick, pw: _pw })
    state.user = nick; state.status = 'ready'; state.error = ''
    planStore.setData(r.data)
    emit()
    return { ok: true }
  },

  async login(nick, pw) {
    nick = String(nick || '').trim()
    state.status = 'loading'; state.error = ''; emit()
    const r = await api('login', { nick, pw })
    if (!r.ok) { state.status = 'error'; state.error = r.error; emit(); return r }
    _pw = String(pw); saveSession({ nick, pw: _pw })
    state.user = nick; state.status = 'ready'; state.error = ''
    planStore.setData(r.data)
    emit()
    return { ok: true }
  },

  logout() {
    saveSession(null); _pw = null
    state.user = null; state.status = 'idle'
    planStore.setData({ plan: [], holding: [], closed: [] })
    emit()
  },

  // 供 planStore 保存数据到云端
  async saveData(data) {
    if (!state.user || !_pw) return
    await api('save', { nick: state.user, pw: _pw, data })
  },
  currentUser() { return state.user },
}

export function useAuthStore() {
  return useSyncExternalStore(authStore.subscribe, authStore.get)
}

// 注册云端保存回调：planStore 数据变更 → 防抖后写回当前账号
planStore.registerSaver((data) => { authStore.saveData(data) })
