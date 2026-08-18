import EASPackage, {
  DescribeServiceRequest,
  StartServiceRequest,
  StopServiceRequest,
} from '@alicloud/eas20210701/dist/client.js'
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
const EAS_HOST_RE = /(^|\.)pai-eas\.aliyuncs\.com$/i
const STARTING_STATUSES = new Set([
  'Creating',
  'Starting',
  'Waiting',
  'Updating',
])
const STOPPING_STATUSES = new Set(['Stopping'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function unavailableProductionModelMetrics() {
  return {
    available: false,
    loaded: false,
    primaryLabel: '样本外 AUC',
    primaryAucPct: null,
    holdoutAucPct: null,
    cvAucPct: null,
    sampleCount: null,
    dataEndDate: '',
    featureCount: null,
    horizonDays: null,
  }
}

function aucPct(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return null
  return +(numeric * 100).toFixed(2)
}

function positiveInteger(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0
    ? Math.round(numeric)
    : null
}

export function normalizeProductionModelMetrics(payload) {
  const meta = payload?.meta
  if (!payload?.loaded || !meta || typeof meta !== 'object') {
    return unavailableProductionModelMetrics()
  }
  const holdoutAucPct = aucPct(meta.holdout_auc)
  const cvAucPct = aucPct(meta.cv_auc)
  const primaryAucPct = holdoutAucPct ?? cvAucPct
  const featureCount = Array.isArray(meta.feat_names)
    ? meta.feat_names.length
    : positiveInteger(meta.feature_count)
  return {
    available: primaryAucPct != null,
    loaded: true,
    primaryLabel: holdoutAucPct != null ? '样本外 AUC' : '时序 CV AUC',
    primaryAucPct,
    holdoutAucPct,
    cvAucPct,
    sampleCount: positiveInteger(meta.n_samples),
    dataEndDate: String(meta.data_end_date || ''),
    featureCount,
    horizonDays: positiveInteger(meta.horizon),
  }
}

export async function getProductionModelMetrics({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  const baseUrl = String(env.QUANT_URL || '').trim().replace(/\/+$/, '')
  if (!baseUrl) return unavailableProductionModelMetrics()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const apiKey = String(env.QUANT_KEY || '')
    const response = await fetchImpl(`${baseUrl}/model_info`, {
      signal: controller.signal,
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
    })
    if (!response.ok) return unavailableProductionModelMetrics()
    return normalizeProductionModelMetrics(await response.json())
  } catch {
    return unavailableProductionModelMetrics()
  } finally {
    clearTimeout(timer)
  }
}

export function normalizeV2ServiceEndpoint(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('EAS服务入口缺失')
  const withProtocol = /^https?:\/\//i.test(raw)
    ? raw.replace(/^http:/i, 'https:')
    : `https://${raw.replace(/^\/+/, '')}`
  let parsed
  try { parsed = new URL(withProtocol) } catch { throw new Error('EAS服务入口无效') }
  if (parsed.protocol !== 'https:' || !EAS_HOST_RE.test(parsed.hostname)) {
    throw new Error('EAS服务入口必须使用阿里云HTTPS地址')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function v2ApiKeyFromServiceConfig(serviceConfig) {
  let config
  try {
    config = typeof serviceConfig === 'string'
      ? JSON.parse(serviceConfig || '{}')
      : (serviceConfig || {})
  } catch {
    throw new Error('EAS服务配置无效')
  }
  const containers = Array.isArray(config?.containers)
    ? config.containers
    : []
  const entry = containers
    .flatMap((container) => Array.isArray(container?.env) ? container.env : [])
    .find((item) => item?.name === 'SHADOW_API_KEY')
  const apiKey = String(entry?.value || '')
  if (!apiKey) throw new Error('EAS服务API Key缺失')
  return apiKey
}

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
    showV2Switch: selected !== 'default',
    experimental: selected === 'v2.1',
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

export async function getV2RuntimeConfig({
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
      const body = response?.body || {}
      const easToken = String(body.accessToken || '')
      if (!easToken) throw new Error('EAS服务Token缺失')
      return {
        url: normalizeV2ServiceEndpoint(body.internetEndpoint),
        easToken,
        apiKey: v2ApiKeyFromServiceConfig(body.serviceConfig),
        status: String(body.status || 'Unknown'),
      }
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) await sleepImpl(EAS_RETRY_MS)
    }
  }
  throw lastError || new Error('EAS运行配置查询失败')
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
