const DEFAULT_BASE_URL = 'http://127.0.0.1:7899'
const ALLOWED_TABLES = new Set(['日k', '分钟k', '资金流', '股票代码'])
const ALLOWED_COMMANDS = new Set(['get', 'vals'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function safeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_BASE_URL))
  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
  ) {
    throw new Error('StockDB只允许通过本机回环HTTP地址访问')
  }
  return url
}

function safeTable(value) {
  const table = String(value || '')
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`StockDB数据表不允许读取: ${table}`)
  }
  return table
}

function safeCommand(value) {
  const command = String(value || '')
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`StockDB查询命令不允许执行: ${command}`)
  }
  return command
}

function safeCodePattern(value) {
  const pattern = String(value || '')
  if (!/^(?:\d{1,6}\*|\d{6})$/.test(pattern)) {
    throw new Error('StockDB股票代码表达式无效')
  }
  return pattern
}

function safeDateQuery(value, minute = false) {
  const digits = minute ? '(?:\\d{8}|\\d{14})' : '\\d{8}'
  const pattern = new RegExp(
    `^(?:${digits}|${digits}\\*|${digits}<${digits})$`,
  )
  const query = String(value || '')
  if (!pattern.test(query)) {
    throw new Error('StockDB日期表达式无效')
  }
  return query
}

function keyArgument(value) {
  if (value.endsWith('*')) return `qz:${value.slice(0, -1)}`
  if (value.includes('<')) {
    const [from, to] = value.split('<')
    return `fwd:${from},${to}`
  }
  return `key:${value}`
}

function safeFields(values) {
  const fields = Array.isArray(values) ? values : []
  if (!fields.length) return null
  if (
    fields.length > 32
    || fields.some((value) => !/^[a-z][a-z0-9_]{0,39}$/i.test(value))
  ) {
    throw new Error('StockDB字段投影无效')
  }
  return fields.join(',')
}

export function buildStockDbUrl({
  baseUrl = DEFAULT_BASE_URL,
  command,
  table,
  codePattern,
  dateQuery,
  fields = [],
} = {}) {
  const url = safeBaseUrl(baseUrl)
  url.pathname = '/'
  url.search = ''
  url.searchParams.set('cmd', safeCommand(command))
  url.searchParams.set('t', safeTable(table))
  if (codePattern != null) {
    url.searchParams.set('k1', keyArgument(safeCodePattern(codePattern)))
  }
  if (dateQuery != null) {
    if (codePattern == null) {
      throw new Error('StockDB日期查询缺少股票代码')
    }
    url.searchParams.set(
      'k2',
      keyArgument(
        safeDateQuery(dateQuery, table === '分钟k'),
      ),
    )
  }
  const projection = safeFields(fields)
  if (projection) url.searchParams.set('ap', `get.${projection}`)
  return url
}

async function readJsonResponse(response, maximumBytes) {
  if (!response.ok) {
    throw new Error(`StockDB返回HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error('StockDB响应超过大小上限')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximumBytes) {
    throw new Error('StockDB响应超过大小上限')
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } finally {
    bytes.fill(0)
  }
}

export function createStockDbHttpClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  maximumBytes = 256 * 1024 * 1024,
} = {}) {
  const endpoint = safeBaseUrl(baseUrl).toString()
  if (typeof fetchImpl !== 'function') {
    throw new Error('StockDB需要可用的fetch实现')
  }
  const query = async (input) => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('StockDB查询超时')),
      timeoutMs,
    )
    try {
      const response = await fetchImpl(
        buildStockDbUrl({ ...input, baseUrl: endpoint }),
        {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        },
      )
      return await readJsonResponse(response, maximumBytes)
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    getStockCodes: () => query({
      command: 'get',
      table: '股票代码',
    }),
    values: (table, codePattern, dateQuery, fields = []) => query({
      command: 'vals',
      table,
      codePattern,
      dateQuery,
      fields,
    }),
  }
}
