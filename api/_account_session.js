import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const VERSION = 'v1'
export const ACCOUNT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

export function accountSessionSecret(env = process.env) {
  return String(env?.ACCOUNT_SESSION_SECRET || env?.CRON_KEY || '')
}

function signature(account, payload, secret) {
  if (!account?.nick || !account?.pwHash || !secret) return ''
  return createHmac('sha256', secret)
    .update(`account-session:${account.nick}:${account.pwHash}:${payload}`)
    .digest('base64url')
}

export function createAccountSessionToken(
  account,
  {
    secret = accountSessionSecret(),
    now = Date.now(),
    maxAgeSeconds = ACCOUNT_SESSION_MAX_AGE_SECONDS,
  } = {},
) {
  if (!account?.nick || !account?.pwHash || !secret) {
    throw new Error('账号会话密钥未配置')
  }
  const expiresAt = Math.floor(now / 1000) + maxAgeSeconds
  const nonce = randomBytes(18).toString('base64url')
  const payload = `${VERSION}.${expiresAt}.${nonce}`
  return `${payload}.${signature(account, payload, secret)}`
}

export function verifyAccountSessionToken(
  account,
  token,
  {
    secret = accountSessionSecret(),
    now = Date.now(),
  } = {},
) {
  if (!account?.nick || !account?.pwHash || !token || !secret) return false
  const parts = String(token).split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return false
  const [version, expiresRaw, nonce, supplied] = parts
  const expiresAt = Number(expiresRaw)
  if (
    !Number.isInteger(expiresAt)
    || expiresAt <= Math.floor(now / 1000)
    || !/^[A-Za-z0-9_-]{12,64}$/.test(nonce)
  ) return false
  const payload = `${version}.${expiresAt}.${nonce}`
  return safeEqual(signature(account, payload, secret), supplied)
}
