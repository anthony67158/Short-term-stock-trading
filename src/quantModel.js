import { planStore } from './planStore.js'
import { QUANT_MODEL_DEFAULT } from '../shared/modelVersion.js'
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
    const stored = planStore.getSetting(
      QUANT_MODEL_SETTING,
      QUANT_MODEL_DEFAULT,
    )
    if (stored !== QUANT_MODEL_DEFAULT) {
      planStore.setSetting(
        QUANT_MODEL_SETTING,
        QUANT_MODEL_DEFAULT,
      )
    }
  } catch {
    // 账号尚未恢复时也只使用默认辅助模型。
  }
  return QUANT_MODEL_DEFAULT
}

export function quantModelQuery() {
  return `&model=${QUANT_MODEL_DEFAULT}`
}

export function accountRequestHeaders() {
  return accountCredentialHeaders(accountCredentials())
}

export function quantModelHeaders() {
  return accountRequestHeaders()
}

export function withQuantModelPayload(payload) {
  return {
    ...(payload || {}),
    quantModelVersion: QUANT_MODEL_DEFAULT,
  }
}
