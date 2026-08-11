import EASPackage, {
  DescribeServiceRequest,
  StartServiceRequest,
  StopServiceRequest,
} from '@alicloud/eas20210701'
import { $OpenApiUtil } from '@alicloud/openapi-core'
import {
  normalizeQuantModelVersion,
  quantModelLabel,
} from '../shared/modelVersion.js'
import { isAuthorizedAccount } from './_account_auth.js'

export const V2_CLUSTER_ID = 'cn-hangzhou'
export const V2_SERVICE_NAME = 'stock_quant_lab_shadow'
const EASClient = EASPackage.default || EASPackage
const EAS_STATUS_ATTEMPTS = 3
const EAS_RETRY_MS = 800
const STARTING_STATUSES = new Set([
  'Creating',
  'Starting',
  'Waiting',
  'Updating',
])
const STOPPING_STATUSES = new Set(['Stopping'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function easClient(env = process.env) {
  const accessKeyId = env.EAS_ACCESS_KEY_ID || env.OSS_ACCESS_KEY_ID
  const accessKeySecret = env.EAS_ACCESS_KEY_SECRET || env.OSS_ACCESS_KEY_SECRET
  if (!accessKeyId || !accessKeySecret) throw new Error('EAS控制凭证未配置')
  return new EASClient(new $OpenApiUtil.Config({
    accessKeyId,
    accessKeySecret,
    regionId: V2_CLUSTER_ID,
    connectTimeout: 10000,
    readTimeout: 10000,
  }))
}

export function applyModelSelection(data, value, now = Date.now()) {
  const selected = normalizeQuantModelVersion(value)
  data.settings = {
    ...(data.settings || {}),
    quantModelVersion: selected,
    quantModelUpdatedAt: now,
  }
  return selected
}

export function canControlV2Service(account, options = {}) {
  return isAuthorizedAccount(account, options)
}

export function modelControlView(
  data,
  {
    v2Status = 'Unknown',
    canControlV2 = false,
  } = {},
) {
  const selected = normalizeQuantModelVersion(data?.settings?.quantModelVersion)
  const normalizedStatus = String(v2Status || 'Unknown')
  const v2Enabled = normalizedStatus === 'Running'
  const v2Starting = STARTING_STATUSES.has(normalizedStatus)
  const v2Stopping = STOPPING_STATUSES.has(normalizedStatus)
  return {
    selected,
    label: quantModelLabel(selected),
    available: selected === 'default' || v2Enabled,
    showV2Switch: selected === 'v2',
    canControlV2: !!canControlV2,
    v2Enabled,
    v2Starting,
    v2Stopping,
    v2Transitioning: v2Starting || v2Stopping,
    v2Status: normalizedStatus,
  }
}

export async function getV2ServiceStatus({
  client = easClient(),
  attempts = EAS_STATUS_ATTEMPTS,
  sleepImpl = sleep,
} = {}) {
  let lastError = null
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      const response = await client.describeService(
        V2_CLUSTER_ID,
        V2_SERVICE_NAME,
        new DescribeServiceRequest({}),
      )
      return String(response?.body?.status || 'Unknown')
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) await sleepImpl(EAS_RETRY_MS)
    }
  }
  throw lastError || new Error('EAS状态查询失败')
}

export async function resolveV2ServiceStatus(
  fallback = 'Unknown',
  {
    getStatus = getV2ServiceStatus,
  } = {},
) {
  try {
    return await getStatus()
  } catch {
    return String(fallback || 'Unknown')
  }
}

export async function setV2ServiceEnabled(enabled, { client = easClient() } = {}) {
  const transitionStatus = enabled ? 'Starting' : 'Stopping'
  try {
    if (enabled) {
      await client.startService(
        V2_CLUSTER_ID,
        V2_SERVICE_NAME,
        new StartServiceRequest({}),
      )
    } else {
      await client.stopService(
        V2_CLUSTER_ID,
        V2_SERVICE_NAME,
        new StopServiceRequest({}),
      )
    }
  } catch (error) {
    const observed = await resolveV2ServiceStatus('Unknown', {
      getStatus: () => getV2ServiceStatus({ client }),
    })
    const accepted = enabled
      ? observed === 'Running' || STARTING_STATUSES.has(observed)
      : observed === 'Stopped' || STOPPING_STATUSES.has(observed)
    if (!accepted) throw error
    return { status: observed, accepted: true }
  }
  return { status: transitionStatus, accepted: true }
}
