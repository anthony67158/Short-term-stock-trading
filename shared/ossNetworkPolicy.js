const INTERNAL_OSS_HOST = /^oss-[a-z0-9-]+-internal\.aliyuncs\.com$/i

export function allowOssPublicNetwork(env = process.env) {
  return String(env.OSS_ALLOW_PUBLIC_NETWORK || '').trim().toLowerCase() === 'true'
}

export function isInternalOssEndpoint(endpoint) {
  const value = String(endpoint || '').trim()
  if (!value) return false
  try {
    return INTERNAL_OSS_HOST.test(new URL(value).hostname)
  } catch {
    return INTERNAL_OSS_HOST.test(value.replace(/^\/+|\/+$/g, ''))
  }
}

export function resolveOssEndpoint(
  env = process.env,
  endpoint = env.OSS_ENDPOINT,
) {
  const value = String(endpoint || '').trim()
  if (isInternalOssEndpoint(value)) return value
  if (allowOssPublicNetwork(env)) return value || null
  throw new Error('OSS公网访问已禁用，请通过阿里云同地域内网Endpoint访问')
}
