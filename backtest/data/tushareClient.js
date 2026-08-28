// Tushare Pro 数据客户端 —— 回测历史数据的唯一拉取入口。
//
// 纪律：
//   - token 只从环境变量 TUSHARE_TOKEN 读取，绝不入库、绝不打印明文。
//   - 传输(fetchTushare)与解析(normalizeDaily / mergeAdjFactor)分离，
//     解析为纯函数、可离线测试；网络层薄封装、带超时与限频重试。
//   - 回测用【后复权】价格跑信号(qfq/hfq 一致性)，避免除权跳空造成假信号。
//
// Tushare Pro API：POST https://api.tushare.pro
//   body = { api_name, token, params, fields }
//   resp = { code, msg, data:{ fields:[...], items:[[...],...] } }

// Tushare Pro API 端点：默认走官方 api.tushare.pro；若使用第三方代理
// （如周卡代理 ts.gyzcloud.top），用环境变量 TUSHARE_API_URL 覆盖。
const DEFAULT_TUSHARE_ENDPOINT = 'https://api.tushare.pro'

export function resolveTushareEndpoint(env = process.env) {
  const url = String(env?.TUSHARE_API_URL || '').trim()
  return url || DEFAULT_TUSHARE_ENDPOINT
}

export function resolveTushareToken(env = process.env) {
  const token = String(env?.TUSHARE_TOKEN || '').trim()
  return token || null
}

// 把 Tushare 的 { fields, items } 表格转成对象数组，纯函数、便于测试。
export function tableToRows(data) {
  const fields = Array.isArray(data?.fields) ? data.fields : []
  const items = Array.isArray(data?.items) ? data.items : []
  if (!fields.length) return []
  return items.map((row) => {
    const record = {}
    for (let i = 0; i < fields.length; i += 1) {
      record[fields[i]] = row[i]
    }
    return record
  })
}

// 薄网络层：POST + 超时；Tushare 业务错误(code!=0)抛出可读错误。
export async function fetchTushare(
  apiName,
  params = {},
  fields = '',
  {
    token = resolveTushareToken(),
    endpoint = resolveTushareEndpoint(),
    timeoutMs = 20000,
  } = {},
) {
  if (!token) {
    throw new Error('缺少 TUSHARE_TOKEN，无法拉取历史数据')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 代理不加此头可能返回 gzip 乱码；fetch 会自动解压。
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify({ api_name: apiName, token, params, fields }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new Error(`Tushare HTTP ${response.status}`)
  }
  const payload = await response.json()
  if (payload.code !== 0) {
    // 不打印 token；40101=token错误、40203=限频。
    throw new Error(`Tushare 业务错误 code=${payload.code} msg=${payload.msg || ''}`)
  }
  return tableToRows(payload.data)
}

// 归一化日线为回测引擎所需结构（不复权原始价）。
export function normalizeDaily(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: normDate(row.trade_date),
      open: numeric(row.open),
      high: numeric(row.high),
      low: numeric(row.low),
      close: numeric(row.close),
      preClose: numeric(row.pre_close),
      volume: numeric(row.vol), // Tushare vol 单位为手
      amount: numeric(row.amount), // 千元
    }))
    .filter((bar) => bar.date && bar.open != null && bar.close != null)
    .sort((left, right) => (left.date < right.date ? -1 : 1))
}

// 合成后复权价：hfq_price = raw_price * (adj_factor / latest_adj_factor)。
// 后复权保持最新价与真实盘面一致，历史价按复权因子放缩，信号计算用它。
export function mergeAdjFactor(dailyRows = [], adjRows = []) {
  const adjByDate = new Map(
    (Array.isArray(adjRows) ? adjRows : []).map((row) => [
      String(row.trade_date || '').replaceAll('-', ''),
      numeric(row.adj_factor),
    ]),
  )
  const daily = normalizeDaily(dailyRows)
  if (!daily.length) return []
  // 最新交易日的复权因子作为基准（后复权基准=最新）。
  const latestFactor = daily
    .map((bar) => adjByDate.get(bar.date))
    .filter((value) => value != null)
    .at(-1) ?? 1
  return daily.map((bar) => {
    const factor = adjByDate.get(bar.date)
    const scale = (factor != null && latestFactor)
      ? factor / latestFactor
      : 1
    return {
      ...bar,
      // 保留原始价，另存后复权价供策略使用。
      hfqOpen: roundP(bar.open * scale),
      hfqHigh: roundP(bar.high * scale),
      hfqLow: roundP(bar.low * scale),
      hfqClose: roundP(bar.close * scale),
      hfqPreClose: bar.preClose != null ? roundP(bar.preClose * scale) : null,
      adjFactor: factor ?? null,
    }
  })
}

function numeric(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normDate(value) {
  const compact = String(value ?? '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function roundP(value) {
  return value == null ? null : +Number(value).toFixed(3)
}
