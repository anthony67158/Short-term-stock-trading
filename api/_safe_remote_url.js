import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
]) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

function normalizedHostname(value) {
  return String(value || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

export function isPublicRemoteAddress(address, family = isIP(address)) {
  const value = normalizedHostname(address)
  if (family === 4) return !blocked.check(value, 'ipv4')
  if (family !== 6) return false
  if (blocked.check(value, 'ipv6')) return false
  return /^[23]/i.test(value)
}

export async function assertSafeRemoteUrl(
  value,
  { lookup = dnsLookup } = {},
) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 2048) throw new Error('远程端点 URL 无效')

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('远程端点 URL 无效')
  }
  if (url.protocol !== 'https:') throw new Error('远程端点只允许 HTTPS')
  if (url.username || url.password) throw new Error('远程端点 URL 禁止携带凭证')
  if (url.search || url.hash) throw new Error('远程端点 URL 禁止查询参数或片段')

  const hostname = normalizedHostname(url.hostname)
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || (!isIP(hostname) && !hostname.includes('.'))
  ) {
    throw new Error('远程端点不能指向本机或内部主机')
  }

  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (
    !Array.isArray(addresses)
    || !addresses.length
    || addresses.some(({ address, family }) =>
      !isPublicRemoteAddress(address, family)
    )
  ) {
    throw new Error('远程端点必须解析到公网地址')
  }

  return url.toString().replace(/\/+$/, '')
}

function supportedPushService(hostname) {
  const host = normalizedHostname(hostname)
  return (
    host === 'fcm.googleapis.com'
    || host === 'android.googleapis.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.apple.com')
    || host === 'updates.push.services.mozilla.com'
    || host.endsWith('.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com')
  )
}

export async function assertSafeWebPushEndpoint(value, options = {}) {
  const safe = await assertSafeRemoteUrl(value, options)
  if (!supportedPushService(new URL(safe).hostname)) {
    throw new Error('订阅端点不是受支持的浏览器 Push Service')
  }
  return safe
}
