import { planStore } from './planStore.js'
import { normalizeQuantModelVersion } from '../shared/modelVersion.js'
import {
  accountCredentialHeaders,
  parseStoredAccountSession,
} from '../shared/accountCredentials.js'

export const QUANT_MODEL_SETTING = 'quantModelVersion'
const ACCOUNT_SESSION_KEY = 'cloud_session_v1'

function accountCredentials() {
  try {
    const value = JSON.parse(localStorage.getItem(ACCOUNT_SESSION_KEY) || 'null')
    const session = parseStoredAccountSession(value)
    return session && !session.legacyPassword
      ? session.credentials
      : null
  } catch {
    return null
  }
}

export function currentQuantModelVersion() {
  try {
    return normalizeQuantModelVersion(
      planStore.getSetting(QUANT_MODEL_SETTING, 'default'),
    )
  } catch {
    return 'default'
  }
}

export function quantModelQuery(version = currentQuantModelVersion()) {
  return `&model=${encodeURIComponent(normalizeQuantModelVersion(version))}`
}

export function accountRequestHeaders() {
  return accountCredentialHeaders(accountCredentials())
}

export function quantModelHeaders(version = currentQuantModelVersion()) {
  if (normalizeQuantModelVersion(version) === 'default') return {}
  return accountRequestHeaders()
}

export function withQuantModelPayload(
  payload,
  version = currentQuantModelVersion(),
) {
  return {
    ...(payload || {}),
    quantModelVersion: normalizeQuantModelVersion(version),
  }
}
