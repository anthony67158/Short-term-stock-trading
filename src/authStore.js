import { useSyncExternalStore } from 'react'
import { planStore } from './planStore'
import { api as apiUrl } from './apiBase'

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
  const r = await fetch(apiUrl('/api/account'), {
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
  // 供 Web Push 订阅上报:把订阅绑到当前账号(服务端据此推给对的人)。仅内存,不落盘额外副本。
  getCreds() { return (state.user && _pw) ? { nick: state.user, pw: _pw } : null },

  // 运行时【定期拉取】云端数据并【非破坏式合并】到本地。
  // 解决"手机上生成的 AI 操作建议,电脑浏览器不刷新"——之前只在 boot/login 拉一次,
  // 运行中从不复拉,桌面端会一直停在旧数据。这里周期性 get,交给 planStore.mergeCloud 按时间戳合并
  // (只补更新的建议/决策,绝不覆盖本机正在编辑的持仓/账户),实现"手机生成、电脑自动看到"。
  async pull() {
    if (!state.user || !_pw) return false
    if (_pulling) return false
    _pulling = true
    try {
      const r = await api('get', { nick: state.user, pw: _pw })
      if (r && r.ok && r.data) {
        try { planStore.mergeCloud(r.data) } catch { /* ignore */ }
        return true
      }
      return false
    } catch { return false } finally { _pulling = false }
  },
}

let _pulling = false
let _pullTimer = null
const PULL_INTERVAL = 45 * 1000  // 45s 轮询一次云端(登录态才跑);切前台/重新可见时也补拉一次

// 启动跨设备同步轮询:仅在浏览器环境、登录后运行。关标签页即停(纯前端增量同步,与云端定时生成无关)。
export function startCloudSync() {
  if (typeof window === 'undefined') return
  if (_pullTimer) return
  _pullTimer = setInterval(() => { try { authStore.pull() } catch { /* ignore */ } }, PULL_INTERVAL)
  // 页面重新可见/窗口聚焦 → 立刻补拉一次(用户从手机切回电脑那一刻就能看到最新建议)
  const kick = () => { if (document.visibilityState === 'visible') { try { authStore.pull() } catch { /* ignore */ } } }
  document.addEventListener('visibilitychange', kick)
  window.addEventListener('focus', kick)
}

export function useAuthStore() {
  return useSyncExternalStore(authStore.subscribe, authStore.get)
}

// 注册云端保存回调：planStore 数据变更 → 防抖后写回当前账号
planStore.registerSaver((data) => { authStore.saveData(data) })
