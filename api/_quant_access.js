import { normalizeQuantModelVersion } from '../shared/modelVersion.js'
import {
  authenticateAccountRequest,
  isAuthorizedAccount,
} from './_account_auth.js'

export const TRUSTED_QUANT_VERSION = Symbol('trustedQuantVersion')

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
