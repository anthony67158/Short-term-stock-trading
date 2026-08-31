import {
  isAccountActive,
  readAccount as readStoredAccount,
  sha,
} from './account.js'
import { verifyAccountSessionToken } from './_account_session.js'

export const TRUSTED_ACCOUNT_REQUEST = Symbol('trustedAccountRequest')

function decodedHeader(req, name) {
  const raw = req?.headers?.[name]
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

export async function authenticateAccountRequest(
  req,
  {
    readAccount = readStoredAccount,
    hashPassword = sha,
    verifySession = verifyAccountSessionToken,
    sessionSecret,
    includeAdviceRuntime = true,
  } = {},
) {
  if (req?.[TRUSTED_ACCOUNT_REQUEST] === true) {
    return { ok: true, trusted: true, account: null }
  }

  const nick = decodedHeader(req, 'x-account-nick').trim()
  const token = decodedHeader(req, 'x-account-token')
  const password = decodedHeader(req, 'x-account-password')
  if (!nick || (!token && !password)) return { ok: false, error: '请先登录' }

  const account = await readAccount(
    nick,
    undefined,
    { includeAdviceRuntime },
  )
  if (
    !account
    || !isAccountActive(account)
    || (
      !verifySession(account, token, { secret: sessionSecret })
      && account.pwHash !== hashPassword(password)
    )
  ) {
    return { ok: false, error: '账号鉴权失败' }
  }
  return { ok: true, trusted: false, account }
}

function authorizedHashes(env) {
  return new Set(
    String(env?.AUTHORIZED_ACCOUNT_HASHES || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  )
}

function configuredHashes(env, key) {
  return String(env?.[key] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

export function isAuthorizedAccount(
  account,
  {
    env = process.env,
    hashAccount = (nick) => sha(`u:${nick}`),
  } = {},
) {
  if (!account?.nick) return false
  const allowed = authorizedHashes(env)
  if (!allowed.size) return false
  return allowed.has(String(hashAccount(account.nick)).toLowerCase())
}

export function isRuntimeConfigAdmin(
  account,
  {
    env = process.env,
    hashAccount = (nick) => sha(`u:${nick}`),
  } = {},
) {
  if (!account?.nick) return false
  const accountHash = String(hashAccount(account.nick)).toLowerCase()
  const admins = configuredHashes(env, 'RUNTIME_CONFIG_ADMIN_HASHES')
  if (admins.length) return admins.includes(accountHash)
  const paid = configuredHashes(env, 'AUTHORIZED_ACCOUNT_HASHES')
  return paid.length === 1 && paid[0] === accountHash
}

export async function authorizePaidRequest(req, options = {}) {
  const authentication = await authenticateAccountRequest(req, options)
  if (!authentication.ok || authentication.trusted) return authentication
  if (!isAuthorizedAccount(authentication.account, options)) {
    return { ok: false, error: '当前账号无权使用付费AI能力' }
  }
  return authentication
}
