export const PRODUCTION_API_ORIGIN =
  'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run'

function hostOf(req) {
  return String(req?.headers?.host || '').trim()
}

function localOrigin(host) {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i
    .test(host)
    ? `http://${host}`
    : null
}

export function internalApiOrigin(req, env = process.env) {
  const runtimePort = String(
    env?.FC_SERVER_PORT || '',
  ).trim()
  if (/^\d{2,5}$/.test(runtimePort)) {
    return `http://127.0.0.1:${runtimePort}`
  }
  return localOrigin(hostOf(req)) || PRODUCTION_API_ORIGIN
}
