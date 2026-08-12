import { useSyncExternalStore } from 'react'
import { planStore } from './planStore'
import { api as apiUrl } from './apiBase'
import { isBatchRunning } from './adviceBatch'
import {
  accountTradeStateFingerprint,
  createCloudSaveQueue,
  sameAccountTradeState,
  saveWithRevisionRecovery,
} from '../shared/accountSync.js'

// ============ 云端账号体系（阿里云 OSS 持久化，跨设备同步）============
// 会话（昵称+密码）持久化在本机 localStorage，保持长期登录（关标签页/切后台不掉线）；数据存云端。
const SESS = 'cloud_session_v1'
const LEGACY_KEY = 'trade_book_v2' // 旧的无账号本机数据(供首次注册导入)
const OUTBOX_KEY = 'cloud_save_outbox_v1'

function readOutbox(nick) {
  try {
    const values = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}')
    const value = values?.[nick]
    return value?.data ? value : null
  } catch {
    return null
  }
}
function writeOutbox(value) {
  try {
    const values = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}')
    values[value.nick] = value
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(values))
  } catch { /* ignore */ }
}
function settleOutbox(nick, id, revision, syncedData) {
  try {
    const current = readOutbox(nick)
    if (!current) return
    const values = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}')
    if (current.id === id) {
      delete values[nick]
    } else {
      values[nick] = {
        ...current,
        baseRevision: revision,
        baseTradeFingerprint: accountTradeStateFingerprint(syncedData),
      }
    }
    if (Object.keys(values).length) {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(values))
    } else {
      localStorage.removeItem(OUTBOX_KEY)
    }
  } catch { /* ignore */ }
}

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
  syncStatus: 'idle', // idle | saving | synced | error | conflict
  syncError: '',
  lastSyncedAt: 0,
}
const listeners = new Set()
function emit() { state = { ...state }; listeners.forEach((l) => { try { l() } catch (e) { console.error('[store] listener error', e) } }) }

let _pw = null // 密码仅保存在内存 + sessionStorage，用于后续保存
let _cloudRevision = 0
let _lastSyncedTradeFingerprint = ''

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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const r = await fetch(apiUrl('/api/account'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    })
    const raw = await r.text()
    try { return JSON.parse(raw) } catch { return { ok: false, error: `服务异常(${r.status})` } }
  } finally {
    clearTimeout(timeout)
  }
}

const cloudSaveQueue = createCloudSaveQueue({
  async save({
    nick,
    pw,
    data,
    outboxId,
    lockedBaseRevision,
    baseTradeFingerprint,
  }) {
    const response = await saveWithRevisionRecovery({
      payload: {
        nick,
        pw,
        data,
        baseRevision: Number.isInteger(lockedBaseRevision)
          ? lockedBaseRevision
          : _cloudRevision,
        baseTradeFingerprint: baseTradeFingerprint
          || _lastSyncedTradeFingerprint,
      },
      save: (payload) => api('save', payload),
      getLatest: () => api('get', { nick, pw }),
      onRevision: (revision) => { _cloudRevision = revision },
    })
    if (response?.ok && Number.isInteger(response.revision)) {
      _cloudRevision = response.revision
      _lastSyncedTradeFingerprint = accountTradeStateFingerprint(data)
      settleOutbox(nick, outboxId, response.revision, data)
    }
    return response
  },
  onState(value) {
    state.syncStatus = value.status
    state.syncError = value.error || ''
    if (value.updatedAt) state.lastSyncedAt = value.updatedAt
    emit()
  },
})

function resumeOutbox(nick, pw) {
  const pending = readOutbox(nick)
  if (!pending) return false
  void cloudSaveQueue.enqueue({
    nick,
    pw,
    data: pending.data,
    outboxId: pending.id,
    lockedBaseRevision: Number.isInteger(pending.baseRevision)
      ? pending.baseRevision
      : undefined,
    baseTradeFingerprint: pending.baseTradeFingerprint || '',
  })
  return true
}

export const authStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },

  // 启动时尝试用 sessionStorage 里的会话恢复登录并拉云端数据
  async boot() {
    // ★必须保证无论成功/失败都清 booting,否则 api('get') 网络抛错会让应用永久卡在启动页。
    try {
      const s = loadSession()
      if (!s || !s.nick) { return }
      _pw = s.pw
      const r = await api('get', { nick: s.nick, pw: s.pw })
      if (r.ok) {
        state.user = s.nick; state.status = 'ready'
        _cloudRevision = Number(r.revision) || 0
        _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
        state.syncStatus = 'synced'; state.syncError = ''; state.lastSyncedAt = r.updatedAt || 0
        planStore.setData(r.data)
        resumeOutbox(s.nick, s.pw)
      } else {
        saveSession(null); _pw = null
      }
    } catch {
      // 网络/接口异常:保持未登录态,让用户可手动登录(而不是白屏卡死)
      _pw = null
    } finally {
      state.booting = false; emit()
    }
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
    _cloudRevision = Number(r.revision) || 0
    _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
    state.user = nick; state.status = 'ready'; state.error = ''
    state.syncStatus = 'synced'; state.syncError = ''; state.lastSyncedAt = r.updatedAt || Date.now()
    planStore.setData(r.data)
    resumeOutbox(nick, _pw)
    emit()
    return { ok: true }
  },

  async login(nick, pw) {
    nick = String(nick || '').trim()
    state.status = 'loading'; state.error = ''; emit()
    const r = await api('login', { nick, pw })
    if (!r.ok) { state.status = 'error'; state.error = r.error; emit(); return r }
    _pw = String(pw); saveSession({ nick, pw: _pw })
    _cloudRevision = Number(r.revision) || 0
    _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
    state.user = nick; state.status = 'ready'; state.error = ''
    state.syncStatus = 'synced'; state.syncError = ''; state.lastSyncedAt = r.updatedAt || 0
    planStore.setData(r.data)
    resumeOutbox(nick, _pw)
    emit()
    return { ok: true }
  },

  logout() {
    cloudSaveQueue.reset()
    saveSession(null); _pw = null; _cloudRevision = 0
    _lastSyncedTradeFingerprint = ''
    state.user = null; state.status = 'idle'
    state.syncStatus = 'idle'; state.syncError = ''; state.lastSyncedAt = 0
    planStore.setData({ plan: [], holding: [], closed: [] })
    emit()
  },

  // 供 planStore 保存数据到云端
  async saveData(data) {
    if (!state.user || !_pw) return false
    const outboxId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    writeOutbox({
      id: outboxId,
      nick: state.user,
      data,
      at: Date.now(),
      baseRevision: _cloudRevision,
      baseTradeFingerprint: _lastSyncedTradeFingerprint,
    })
    return cloudSaveQueue.enqueue({
      nick: state.user,
      pw: _pw,
      data,
      outboxId,
    })
  },
  retrySave() {
    const pending = state.user && _pw ? readOutbox(state.user) : null
    if (pending) {
      return cloudSaveQueue.enqueue({
        nick: state.user,
        pw: _pw,
        data: pending.data,
        outboxId: pending.id,
        lockedBaseRevision: Number.isInteger(pending.baseRevision)
          ? pending.baseRevision
          : undefined,
        baseTradeFingerprint: pending.baseTradeFingerprint || '',
      })
    }
    return cloudSaveQueue.retry()
  },
  async deactivate() {
    if (!state.user || !_pw) return { ok: false, error: '当前未登录' }
    const flushed = await this.retrySave()
    if (!flushed) return { ok: false, error: '最新账号数据尚未保存到 OSS，请稍后重试' }
    const response = await api('deactivate', { nick: state.user, pw: _pw })
    if (!response.ok) return response
    this.logout()
    return response
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
        // pull 只增量合并 AI/预警，并未合并 holding/closed。
        // 不能在此提升 revision，否则旧持仓会带着最新 revision 通过保存校验并覆盖云端交易。
        state.lastSyncedAt = r.updatedAt || state.lastSyncedAt
        if (sameAccountTradeState(planStore.get(), r.data)) {
          _cloudRevision = Number(r.revision) || _cloudRevision
          _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
        }
        try { planStore.mergeCloud(r.data) } catch { /* ignore */ }
        return true
      }
      return false
    } catch { return false } finally { _pulling = false }
  },
}

let _pulling = false
let _pullTimer = null
const PULL_INTERVAL = 45 * 1000  // 常态:45s 轮询一次云端(登录态才跑);切前台/重新可见时也补拉一次
const PULL_FAST = 8 * 1000       // 批量生成进行中:加速到 8s,让服务端批量进度近实时同步到本机进度条

// 启动跨设备同步轮询:仅在浏览器环境、登录后运行。关标签页即停(纯前端增量同步,与云端定时生成无关)。
// 用自调度 setTimeout(而非固定 setInterval):批量生成期间自动把间隔缩到 8s,平时回落到 45s——
// 既让「手机生成、电脑同步看到进程」够快,又不在闲时空烧请求。
export function startCloudSync() {
  if (typeof window === 'undefined') return
  if (_pullTimer) return
  const tick = async () => {
    try { await authStore.pull() } catch { /* ignore */ }
    let fast = false
    try { fast = isBatchRunning() } catch { fast = false }
    _pullTimer = setTimeout(tick, fast ? PULL_FAST : PULL_INTERVAL)
  }
  _pullTimer = setTimeout(tick, 0)
  // 页面重新可见/窗口聚焦 → 立刻补拉一次(用户从手机切回电脑那一刻就能看到最新建议)
  const kick = () => { if (document.visibilityState === 'visible') { try { authStore.pull() } catch { /* ignore */ } } }
  document.addEventListener('visibilitychange', kick)
  window.addEventListener('focus', kick)
}

export function useAuthStore() {
  return useSyncExternalStore(authStore.subscribe, authStore.get)
}

// 注册云端保存回调：planStore 数据变更 → 防抖后写回当前账号
planStore.registerSaver((data) => authStore.saveData(data))
