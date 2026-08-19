export class RequestBodyError extends Error {
  constructor(message, { code, statusCode }) {
    super(message)
    this.name = 'RequestBodyError'
    this.code = code
    this.statusCode = statusCode
  }
}

function bodyError(message, code, statusCode) {
  return new RequestBodyError(message, { code, statusCode })
}

export function readRequestBody(
  req,
  {
    maxBytes = 8 * 1024 * 1024,
    timeoutMs = 15_000,
  } = {},
) {
  const limit = Number(maxBytes)
  const timeout = Number(timeoutMs)
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('maxBytes must be a positive integer')
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError('timeoutMs must be a positive number')
  }

  const declared = Number(req?.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(
      bodyError('请求体超过大小限制', 'BODY_TOO_LARGE', 413),
    )
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('aborted', onAborted)
      req.removeListener('error', onError)
    }
    const finish = (error, value = '') => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        finish(bodyError('请求体超过大小限制', 'BODY_TOO_LARGE', 413))
        req.resume()
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'))
    const onAborted = () => finish(
      bodyError('请求在读取完成前中止', 'BODY_ABORTED', 400),
    )
    const onError = () => finish(
      bodyError('请求体读取失败', 'BODY_READ_FAILED', 400),
    )
    const timer = setTimeout(() => {
      finish(bodyError('请求体读取超时', 'BODY_TIMEOUT', 408))
    }, timeout)

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAborted)
    req.once('error', onError)
  })
}
