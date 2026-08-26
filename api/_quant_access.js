import { normalizeQuantModelVersion } from '../shared/modelVersion.js'
import {
  authenticateAccountRequest,
  isAuthorizedAccount,
} from './_account_auth.js'

export const TRUSTED_QUANT_VERSION = Symbol('trustedQuantVersion')

export async function resolveQuantModelForRequest(
  req,
  requestedVersion,
  {
    account = null,
    isAuthorized = isAuthorizedAccount,
    ...authenticationOptions
  } = {},
) {
  const requested = normalizeQuantModelVersion(requestedVersion)
  const trusted = req?.[TRUSTED_QUANT_VERSION]
  if (trusted) return normalizeQuantModelVersion(trusted)

  const internalKey = String(
    req?.headers?.['x-cron-key'] || '',
  )
  if (
    process.env.CRON_KEY
    && internalKey === String(process.env.CRON_KEY)
  ) {
    req[TRUSTED_QUANT_VERSION] = requested
    return requested
  }

  if (account && isAuthorized(account, authenticationOptions)) {
    const selected = normalizeQuantModelVersion(
      account.data?.settings?.quantModelVersion,
    )
    req[TRUSTED_QUANT_VERSION] = selected
    return selected
  }

  const authentication = await authenticateAccountRequest(
    req,
    authenticationOptions,
  )
  if (
    authentication.ok
    && authentication.account
    && isAuthorized(authentication.account, authenticationOptions)
  ) {
    const selected = normalizeQuantModelVersion(
      authentication.account.data?.settings?.quantModelVersion,
    )
    req[TRUSTED_QUANT_VERSION] = selected
    return selected
  }
  return requested
}

export async function canUseQuantModel(
  req,
  version,
  {
    isAuthorized = isAuthorizedAccount,
    ...authenticationOptions
  } = {},
) {
  const selected = normalizeQuantModelVersion(version)
  if (selected === 'default') return true
  if (req?.[TRUSTED_QUANT_VERSION] === selected) return true
  const internalKey = String(
    req?.headers?.['x-cron-key'] || '',
  )
  if (
    process.env.CRON_KEY
    && internalKey === String(process.env.CRON_KEY)
  ) return true

  const authentication = await authenticateAccountRequest(
    req,
    authenticationOptions,
  )
  return !!(
    authentication.ok
    && authentication.account
    && isAuthorized(authentication.account, authenticationOptions)
    && normalizeQuantModelVersion(
      authentication.account.data?.settings?.quantModelVersion,
    ) === selected
  )
}
