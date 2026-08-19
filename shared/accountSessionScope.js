let epoch = 0
let account = ''
const listeners = new Set()

export function activateAccountSession(accountName = '') {
  epoch += 1
  account = String(accountName || '').trim()
  const snapshot = currentAccountSession()
  for (const listener of listeners) {
    try { listener(snapshot) } catch { /* 会话清理不能被单个订阅阻断 */ }
  }
  return snapshot
}

export function currentAccountSession() {
  return Object.freeze({ account, epoch })
}

export function accountSessionMatches(snapshot) {
  return !!snapshot
    && snapshot.epoch === epoch
    && snapshot.account === account
}

export function accountScopedStorageKey(key, snapshot = currentAccountSession()) {
  const scope = snapshot?.account
    ? encodeURIComponent(snapshot.account)
    : 'anonymous'
  return `${String(key || '')}:${scope}`
}

export function subscribeAccountSession(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
