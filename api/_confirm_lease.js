import { randomUUID } from 'crypto'
import {
  readAccount as readStoredAccount,
  writeAccount as writeStoredAccount,
} from './account.js'

const LEASE_TTL_MS = 2 * 60 * 1000

function storedAlert(data, requested) {
  return (Array.isArray(data?.alerts) ? data.alerts : [])
    .find((alert) => String(alert?.id || '') === String(requested?.id || ''))
}

export function isAuthoritativeWatchingAlert(data, requested) {
  const stored = storedAlert(data, requested)
  if (
    !stored
    || !stored.enabled
    || stored.phase !== 'watching'
    || String(stored.code || '') !== String(requested?.code || '')
  ) return false
  const requestedPlan = String(requested?.judgeContext?.planId || '')
  const storedPlan = String(stored?.judgeContext?.planId || '')
  return requestedPlan === storedPlan
}

export function ownsConfirmationLease(
  data,
  alertId,
  owner,
  now = Date.now(),
) {
  const alert = storedAlert(data, { id: alertId })
  return !!owner
    && alert?.confirmLease?.owner === owner
    && Number(alert.confirmLease.expiresAt) > now
}

function isWriteConflict(error) {
  return error?.code === 'OSS_WRITE_CONFLICT' || error?.status === 409
}

async function releaseLease({
  nick,
  alertId,
  owner,
  readAccount,
  writeAccount,
}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const account = await readAccount(nick)
    const alert = storedAlert(account?.data, { id: alertId })
    if (!alert || alert.confirmLease?.owner !== owner) return
    delete alert.confirmLease
    try {
      await writeAccount(account, undefined, {
        history: false,
        verify: false,
      })
      return
    } catch (error) {
      if (!isWriteConflict(error) || attempt === 1) return
    }
  }
}

export async function acquireConfirmationLease({
  nick,
  alertId,
  requestedAlert,
  now = Date.now(),
  ttlMs = LEASE_TTL_MS,
  readAccount = readStoredAccount,
  writeAccount = writeStoredAccount,
} = {}) {
  if (!nick || !alertId) {
    return { acquired: false, release: async () => {} }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const account = await readAccount(nick)
    if (!isAuthoritativeWatchingAlert(account?.data, requestedAlert)) {
      return { acquired: false, reason: 'stale-alert', release: async () => {} }
    }
    const alert = storedAlert(account.data, requestedAlert)
    if (Number(alert.confirmLease?.expiresAt) > now) {
      return { acquired: false, reason: 'in-flight', release: async () => {} }
    }
    const owner = randomUUID()
    alert.confirmLease = {
      owner,
      acquiredAt: now,
      expiresAt: now + ttlMs,
    }
    try {
      const saved = await writeAccount(account, undefined, {
        history: false,
        verify: false,
      })
      return {
        acquired: true,
        account: saved,
        alert: storedAlert(saved.data, requestedAlert),
        alertId,
        owner,
        release: () => releaseLease({
          nick,
          alertId,
          owner,
          readAccount,
          writeAccount,
        }),
      }
    } catch (error) {
      if (!isWriteConflict(error) || attempt === 1) throw error
    }
  }
  return { acquired: false, reason: 'write-conflict', release: async () => {} }
}
