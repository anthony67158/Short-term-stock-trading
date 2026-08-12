import { planStore } from './planStore.js'
import { normalizeQuantModelVersion } from '../shared/modelVersion.js'

export const QUANT_MODEL_SETTING = 'quantModelVersion'
const ACCOUNT_SESSION_KEY = 'cloud_session_v1'

function accountCredentials() {
  try {
    const value = JSON.parse(localStorage.getItem(ACCOUNT_SESSION_KEY) || 'null')
    return value?.nick && value?.pw ? value : null
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
  const credentials = accountCredentials()
  if (!credentials) return {}
  return {
    'X-Account-Nick': encodeURIComponent(credentials.nick),
    'X-Account-Password': encodeURIComponent(credentials.pw),
  }
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
