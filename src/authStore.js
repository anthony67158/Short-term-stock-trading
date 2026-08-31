import { useSyncExternalStore } from 'react'
import { planStore } from './planStore'
import { api as apiUrl } from './apiBase'
import { isBatchRunning } from './adviceBatch'
import { accountApiRequest } from './accountRequest.js'
import {
  accountSnapshotForRestore,
  accountTradeStateFingerprint,
  createCloudSaveQueue,
  pendingOutboxAfterReset,
  saveWithRevisionRecovery,
} from '../shared/accountSync.js'
import {
  createAdviceRuntimeSyncCursor,
} from '../shared/adviceAccountSync.js'
import {
  accountCredentialPayload,
  parseStoredAccountSession,
  storedAccountSession,
} from '../shared/accountCredentials.js'
import {
  accountSessionMatches,
  activateAccountSession,
  currentAccountSession,
} from '../shared/accountSessionScope.js'
import {
  clearAccountSnapshotCache,
  readAccountSnapshotCache,
  writeAccountSnapshotCache,
} from './accountSnapshotCache.js'

// ============ 云端账号体系（阿里云 OSS 持久化，跨设备同步）============
// localStorage 只保存昵称和签名会话令牌；旧版本密码会话仅在首次启动时用于换票。
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
function removeOutbox(nick) {
  try {
    const values = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}')
    if (!Object.prototype.hasOwnProperty.call(values, nick)) return
    delete values[nick]
    if (Object.keys(values).length) {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(values))
    } else {
      localStorage.removeItem(OUTBOX_KEY)
    }
  } catch { /* ignore */ }
}
function outboxAfterCloudReset(nick, cloudData) {
  const pending = readOutbox(nick)
  const accepted = pendingOutboxAfterReset(cloudData, pending)
  if (pending && !accepted) removeOutbox(nick)
  return accepted
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
      if (legacy) { sessionStorage.removeItem(SESS); raw = legacy }
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

let _credentials = null
let _cloudRevision = 0
let _lastSyncedTradeFingerprint = ''
let _tradeStateResetAt = 0
const _runtimeSyncCursor = createAdviceRuntimeSyncCursor()

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
  return accountApiRequest(
    apiUrl('/api/account'),
    action,
    payload,
  )
}

const cloudSaveQueue = createCloudSaveQueue({
  async save({
    nick,
    token,
    session,
    data,
    outboxId,
    lockedBaseRevision,
    baseTradeFingerprint,
    forceTradeState = false,
  }) {
    if (!accountSessionMatches(session)) {
      return { ok: false, retryable: false, error: '账号会话已切换' }
    }
    const credentials = accountCredentialPayload({ nick, token })
    const response = await saveWithRevisionRecovery({
      payload: {
        ...credentials,
        data,
        baseRevision: Number.isInteger(lockedBaseRevision)
          ? lockedBaseRevision
          : _cloudRevision,
        baseTradeFingerprint: baseTradeFingerprint
          || _lastSyncedTradeFingerprint,
        ...(forceTradeState ? { forceTradeState: true } : {}),
      },
      save: (payload) => api('save', payload),
      getLatest: () => api('get', credentials),
      onRevision: (revision) => {
        if (accountSessionMatches(session)) _cloudRevision = revision
      },
    })
    if (!accountSessionMatches(session)) return response
    if (response?.ok && Number.isInteger(response.revision)) {
      _cloudRevision = response.revision
      _lastSyncedTradeFingerprint = accountTradeStateFingerprint(data)
      settleOutbox(nick, outboxId, response.revision, data)
      writeAccountSnapshotCache(nick, {
        data,
        updatedAt: response.updatedAt,
        revision: response.revision,
      })
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

function resumeOutbox(
  credentials,
  session = currentAccountSession(),
  pending = readOutbox(credentials?.nick),
) {
  if (!pending) return false
  void cloudSaveQueue.enqueue({
    ...credentials,
    session,
    data: pending.data,
    outboxId: pending.id,
    lockedBaseRevision: Number.isInteger(pending.baseRevision)
      ? pending.baseRevision
      : undefined,
    baseTradeFingerprint: pending.baseTradeFingerprint || '',
  })
  return true
}

function resetAccountRuntime() {
  cloudSaveQueue.reset()
  _credentials = null
  _cloudRevision = 0
  _lastSyncedTradeFingerprint = ''
  _tradeStateResetAt = 0
  _runtimeSyncCursor.reset()
}

function establishAccountSession(nick, token) {
  const credentials = accountCredentialPayload({ nick, token })
  if (!credentials?.token) return null
  _credentials = credentials
  saveSession(storedAccountSession(credentials.nick, credentials.token))
  return activateAccountSession(credentials.nick)
}

export const authStore = {
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  get() { return state },

  // 启动时用签名令牌恢复登录；旧密码会话成功换票后立即从本地删除。
  async boot() {
    resetAccountRuntime()
    const attempt = activateAccountSession('')
    let restoredFromCache = false
    let activeAttempt = attempt
    try {
      const stored = parseStoredAccountSession(loadSession())
      if (!stored) return
      if (stored.legacyPassword) saveSession(null)
      const cached = stored.legacyPassword
        ? null
        : readAccountSnapshotCache(stored.credentials.nick)
      if (cached) {
        const session = establishAccountSession(
          stored.credentials.nick,
          stored.credentials.token,
        )
        if (session) {
          activeAttempt = session
          restoredFromCache = true
          _cloudRevision = Number(cached.revision) || 0
          _lastSyncedTradeFingerprint =
            accountTradeStateFingerprint(cached.data)
          _tradeStateResetAt =
            Number(cached.data?.tradeStateResetAt) || 0
          _runtimeSyncCursor.noteSnapshot(cached.updatedAt)
          state.user = stored.credentials.nick
          state.status = 'ready'
          state.error = ''
          state.syncStatus = 'restoring'
          state.syncError = ''
          state.lastSyncedAt = Number(cached.updatedAt) || 0
          planStore.setData(cached.data, { provisional: true })
          state.booting = false
          emit()
        }
      }
      const r = await api('get', stored.credentials)
      if (!accountSessionMatches(activeAttempt)) return
      if (r.ok && r.token) {
        const session = restoredFromCache
          ? activeAttempt
          : establishAccountSession(stored.credentials.nick, r.token)
        if (restoredFromCache) {
          _credentials = accountCredentialPayload({
            nick: stored.credentials.nick,
            token: r.token,
          })
          saveSession(storedAccountSession(_credentials.nick, _credentials.token))
        }
        state.user = stored.credentials.nick; state.status = 'ready'
        _cloudRevision = Number(r.revision) || 0
        _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
        _tradeStateResetAt = Number(r.data?.tradeStateResetAt) || 0
        state.syncStatus = 'synced'; state.syncError = ''; state.lastSyncedAt = r.updatedAt || 0
        _runtimeSyncCursor.noteSnapshot(r.updatedAt)
        const pending = outboxAfterCloudReset(
          _credentials.nick,
          r.data,
        )
        const restored = accountSnapshotForRestore(r.data, pending)
        planStore.setData(restored)
        writeAccountSnapshotCache(_credentials.nick, {
          data: restored,
          updatedAt: r.updatedAt,
          revision: r.revision,
        })
        resumeOutbox(_credentials, session, pending)
      } else if (restoredFromCache && r.transient) {
        state.syncStatus = 'error'
        state.syncError = r.error || '云端校验暂时失败'
        emit()
      } else {
        clearAccountSnapshotCache(stored.credentials.nick)
        saveSession(null)
        resetAccountRuntime()
        state.user = null
        state.status = 'idle'
        planStore.setData({ plan: [], holding: [], closed: [] })
        if (accountSessionMatches(activeAttempt)) activateAccountSession('')
      }
    } catch {
      if (accountSessionMatches(activeAttempt) && !restoredFromCache) {
        resetAccountRuntime()
      }
    } finally {
      state.booting = false; emit()
    }
  },

  async register(nick, pw, importLegacy = false) {
    nick = String(nick || '').trim()
    if (!nick) return { ok: false, error: '请输入昵称' }
    if (!pw) return { ok: false, error: '请输入密码' }
    resetAccountRuntime()
    saveSession(null)
    const attempt = activateAccountSession('')
    state.status = 'loading'; state.error = ''; emit()
    const data = importLegacy ? (readLegacyData() || { plan: [], holding: [], closed: [] }) : { plan: [], holding: [], closed: [] }
    const r = await api('register', { nick, pw, data })
    if (!accountSessionMatches(attempt)) return { ok: false, error: '注册请求已失效' }
    if (!r.ok) { state.status = 'error'; state.error = r.error; emit(); return r }
    const session = establishAccountSession(nick, r.token)
    if (!session) {
      state.status = 'error'; state.error = '服务端未签发账号会话'; emit()
      return { ok: false, error: state.error }
    }
    _cloudRevision = Number(r.revision) || 0
    _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
    _tradeStateResetAt = Number(r.data?.tradeStateResetAt) || 0
    state.user = nick; state.status = 'ready'; state.error = ''
    state.syncStatus = 'synced'; state.syncError = ''; state.lastSyncedAt = r.updatedAt || Date.now()
    _runtimeSyncCursor.noteSnapshot(r.updatedAt)
    planStore.setData(r.data)
    writeAccountSnapshotCache(nick, r)
    resumeOutbox(_credentials, session)
    emit()
    return { ok: true }
  },

  async login(nick, pw) {
    nick = String(nick || '').trim()
    resetAccountRuntime()
    saveSession(null)
    const attempt = activateAccountSession('')
    state.status = 'loading'; state.error = ''; emit()
    const r = await api('login', { nick, pw })
    if (!accountSessionMatches(attempt)) return { ok: false, error: '登录请求已失效' }
    if (!r.ok) { state.status = 'error'; state.error = r.error; emit(); return r }
    const session = establishAccountSession(nick, r.token)
    if (!session) {
      state.status = 'error'; state.error = '服务端未签发账号会话'; emit()
      return { ok: false, error: state.error }
    }
    _cloudRevision = Number(r.revision) || 0
    _lastSyncedTradeFingerprint = accountTradeStateFingerprint(r.data)
    _tradeStateResetAt = Number(r.data?.tradeStateResetAt) || 0
    state.user = nick; state.status = 'ready'; state.error = ''
    state.syncStatus = 'synced'; state.syncError = ''; state.lastSyncedAt = r.updatedAt || 0
    _runtimeSyncCursor.noteSnapshot(r.updatedAt)
    const pending = outboxAfterCloudReset(
      _credentials.nick,
      r.data,
    )
    const restored = accountSnapshotForRestore(r.data, pending)
    planStore.setData(restored)
    writeAccountSnapshotCache(nick, {
      ...r,
      data: restored,
    })
    resumeOutbox(_credentials, session, pending)
    emit()
    return { ok: true }
  },

  logout() {
    const nick = _credentials?.nick || state.user
    clearAccountSnapshotCache(nick)
    resetAccountRuntime()
    saveSession(null)
    activateAccountSession('')
    state.user = null; state.status = 'idle'
    state.syncStatus = 'idle'; state.syncError = ''; state.lastSyncedAt = 0
    planStore.setData({ plan: [], holding: [], closed: [] })
    emit()
  },

  // 供 planStore 保存数据到云端
  async saveData(data) {
    const session = currentAccountSession()
    const credentials = accountCredentialPayload(_credentials)
    if (!credentials || !accountSessionMatches(session)) return false
    const outboxId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    writeOutbox({
      id: outboxId,
      nick: credentials.nick,
      data,
      at: Date.now(),
      baseRevision: _cloudRevision,
      baseTradeFingerprint: _lastSyncedTradeFingerprint,
    })
    return cloudSaveQueue.enqueue({
      ...credentials,
      session,
      data,
      outboxId,
    })
  },
  retrySave() {
    const session = currentAccountSession()
    const credentials = accountCredentialPayload(_credentials)
    const pending = credentials && accountSessionMatches(session)
      ? readOutbox(credentials.nick)
      : null
    if (pending) {
      return cloudSaveQueue.enqueue({
        ...credentials,
        session,
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
  async resolveTradeConflict() {
    const session = currentAccountSession()
    const credentials = accountCredentialPayload(_credentials)
    if (!credentials || !accountSessionMatches(session)) {
      return { ok: false, error: '当前未登录' }
    }
    const pending = readOutbox(credentials.nick)
    const data = pending?.data || planStore.get()
    const outboxId = pending?.id
      || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    if (!pending) {
      writeOutbox({
        id: outboxId,
        nick: credentials.nick,
        data,
        at: Date.now(),
        baseRevision: _cloudRevision,
        baseTradeFingerprint: _lastSyncedTradeFingerprint,
      })
    }
    return cloudSaveQueue.enqueue({
      ...credentials,
      session,
      data,
      outboxId,
      lockedBaseRevision: Number.isInteger(pending?.baseRevision)
        ? pending.baseRevision
        : _cloudRevision,
      baseTradeFingerprint:
        pending?.baseTradeFingerprint
        || _lastSyncedTradeFingerprint,
      forceTradeState: true,
    })
  },
  async deactivate() {
    const session = currentAccountSession()
    const credentials = accountCredentialPayload(_credentials)
    if (!credentials || !accountSessionMatches(session)) {
      return { ok: false, error: '当前未登录' }
    }
    const flushed = await this.retrySave()
    if (!accountSessionMatches(session)) return { ok: false, error: '账号会话已切换' }
    if (!flushed) return { ok: false, error: '最新账号数据尚未保存到 OSS，请稍后重试' }
    const response = await api('deactivate', credentials)
    if (!accountSessionMatches(session)) return { ok: false, error: '账号会话已切换' }
    if (!response.ok) return response
    this.logout()
    return response
  },
  currentUser() { return state.user },
  getCreds() {
    const session = currentAccountSession()
    const credentials = accountCredentialPayload(_credentials)
    return credentials && accountSessionMatches(session)
      ? { ...credentials }
      : null
  },

  // 运行时【增量拉取】云端数据并【非破坏式合并】到本地。
  // 解决"手机上生成的 AI 操作建议,电脑浏览器不刷新"——之前只在 boot/login 拉一次,
  // 运行中从不复拉,桌面端会一直停在旧数据。这里周期性 sync,仅返回上次同步后的建议/事件,
  // (只补更新的建议/决策,绝不覆盖本机正在编辑的持仓/账户),实现"手机生成、电脑自动看到"。
  async pull() {
    const session = currentAccountSession()
    const credentials = accountCredentialPayload(_credentials)
    if (!credentials || !accountSessionMatches(session)) return false
    if (_pulling) return false
    _pulling = true
    try {
      const requestedSince = _runtimeSyncCursor.since()
      const r = await api('sync', {
        ...credentials,
        since: requestedSince,
      })
      if (!accountSessionMatches(session)) return false
      if (r && r.ok && r.data) {
        const remoteResetAt = Number(r.data.tradeStateResetAt) || 0
        const pending = outboxAfterCloudReset(
          credentials.nick,
          r.data,
        )
        if (remoteResetAt > _tradeStateResetAt && !pending) {
          const full = await api('get', credentials)
          if (full?.ok && full.data) {
            cloudSaveQueue.reset()
            _cloudRevision = Number(full.revision) || _cloudRevision
            _lastSyncedTradeFingerprint =
              accountTradeStateFingerprint(full.data)
            _tradeStateResetAt =
              Number(full.data.tradeStateResetAt) || remoteResetAt
            _runtimeSyncCursor.noteSnapshot(full.updatedAt)
            planStore.setData(full.data)
            writeAccountSnapshotCache(credentials.nick, full)
            state.syncStatus = 'synced'
            state.syncError = ''
            return true
          }
        }
        if (
          r.tradeFingerprint
          && r.tradeFingerprint === accountTradeStateFingerprint(planStore.get())
        ) {
          _cloudRevision = Number(r.revision) || _cloudRevision
          _lastSyncedTradeFingerprint = r.tradeFingerprint
        }
        try { planStore.mergeCloud(r.data) } catch { return false }
        writeAccountSnapshotCache(credentials.nick, {
          data: planStore.get(),
          updatedAt: r.updatedAt || state.lastSyncedAt,
          revision: Number(r.revision) || _cloudRevision,
        })
        _runtimeSyncCursor.notePull(r.updatedAt)
        state.lastSyncedAt = r.updatedAt || state.lastSyncedAt
        return true
      }
      return false
    } catch { return false } finally { _pulling = false }
  },
}

let _pulling = false
let _pullTimer = null
const PULL_INTERVAL = 30 * 1000  // 常态:30秒增量同步；浏览器只访问FC，FC通过杭州内网读取OSS
const PULL_FAST = 15 * 1000      // 批量生成时15秒；2秒任务状态轮询已负责实时进度

// 启动跨设备同步轮询:仅在浏览器环境、登录后运行。关标签页即停(纯前端增量同步,与云端定时生成无关)。
// 登录/启动已完成一次全量读取，因此首轮无需立刻重复 GET 4 MiB 快照。
export function startCloudSync() {
  if (typeof window === 'undefined') return
  if (_pullTimer) return
  const tick = async () => {
    try { await authStore.pull() } catch { /* ignore */ }
    let fast = false
    try { fast = isBatchRunning() } catch { fast = false }
    _pullTimer = setTimeout(tick, fast ? PULL_FAST : PULL_INTERVAL)
  }
  _pullTimer = setTimeout(tick, PULL_INTERVAL)
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
