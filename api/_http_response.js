import { gzipSync } from 'node:zlib'

export const JSON_GZIP_THRESHOLD_BYTES = 16 * 1024

function acceptsEncoding(header, encoding) {
  return String(header || '')
    .split(',')
    .map((item) => item.trim())
    .some((item) => {
      const [name, ...parameters] = item.split(';')
      if (name.trim().toLowerCase() !== encoding) return false
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=([0-9.]+)$/i)?.[1])
        .find(Boolean)
      return quality == null || Number(quality) > 0
    })
}

function appendVary(res, value) {
  const current = typeof res.getHeader === 'function'
    ? String(res.getHeader('Vary') || '')
    : ''
  const values = current
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
    values.push(value)
  }
  res.setHeader('Vary', values.join(', '))
}

export function sendJsonResponse(req, res, value) {
  return sendSerializedJsonResponse(req, res, JSON.stringify(value))
}

function sendSerializedJsonResponse(req, res, serialized) {
  const raw = Buffer.from(serialized)
  const useGzip = (
    raw.length >= JSON_GZIP_THRESHOLD_BYTES
    && acceptsEncoding(req?.headers?.['accept-encoding'], 'gzip')
  )
  const body = useGzip ? gzipSync(raw, { level: 6 }) : raw

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  if (useGzip) {
    res.setHeader('Content-Encoding', 'gzip')
    appendVary(res, 'Accept-Encoding')
  }
  res.end(body)
  return res
}

export function sendApiResponse(req, res, payload) {
  const contentType = String(
    typeof res.getHeader === 'function'
      ? res.getHeader('Content-Type') || ''
      : '',
  ).toLowerCase()
  if (
    typeof payload !== 'string'
    || contentType.startsWith('application/json')
  ) {
    const serialized = typeof payload === 'string'
      ? payload
      : JSON.stringify(payload)
    return sendSerializedJsonResponse(req, res, serialized)
  }
  res.end(payload)
  return res
}
