const CODE_RE = /^\d{6}$/
const MINUTE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://82.push2his.eastmoney.com',
  'https://48.push2his.eastmoney.com',
]
const TENCENT_MINUTE_HOST = 'https://ifzq.gtimg.cn'

function number(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`分钟数据${name}无效`)
  }
  return parsed
}

function normalizeTime(value) {
  const text = String(value || '').trim().replace('T', ' ')
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) {
    return `${text}:00`
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return text
  }
  throw new Error('分钟时间格式无效')
}

export function parseFiveMinuteKlines(lines) {
  if (!Array.isArray(lines)) throw new Error('分钟K线格式无效')
  return lines.map((line) => {
    const values = Array.isArray(line)
      ? line
      : String(line || '').split(',')
    if (values.length < 6) throw new Error('分钟K线字段不足')
    const open = number(values[1], '开盘价')
    const close = number(values[2], '收盘价')
    const high = number(values[3], '最高价')
    const low = number(values[4], '最低价')
    const volume = number(values[5], '成交量')
    if (
      open <= 0
      || close <= 0
      || low <= 0
      || high < Math.max(open, close)
      || low > Math.min(open, close)
      || volume < 0
    ) {
      throw new Error('分钟OHLCV约束无效')
    }
    return {
      tradeTime: normalizeTime(values[0]),
      open,
      high,
      low,
      close,
      volume,
    }
  }).sort((left, right) =>
    left.tradeTime.localeCompare(right.tradeTime),
  )
}

export function selectCompletedDayEndBars(bars, minimum = 61) {
  if (!Array.isArray(bars)) throw new Error('分钟K线格式无效')
  let closeIndex = -1
  for (let index = bars.length - 1; index >= 0; index--) {
    if (String(bars[index]?.tradeTime || '').endsWith('15:00:00')) {
      closeIndex = index
      break
    }
  }
  if (closeIndex < 0) throw new Error('分钟数据缺少完整收盘窗口')
  const completed = bars.slice(0, closeIndex + 1)
  if (completed.length < minimum) throw new Error('完整分钟窗口不足')
  return completed.slice(-Math.max(minimum, 240))
}

function marketSecid(code) {
  return `${/^(6|9|5)/.test(code) ? '1' : '0'}.${code}`
}

function tencentCode(code) {
  return `${/^(6|9|5)/.test(code) ? 'sh' : 'sz'}${code}`
}

function parseTencentFiveMinuteKlines(rows) {
  if (!Array.isArray(rows)) throw new Error('腾讯分钟K线格式无效')
  return parseFiveMinuteKlines(rows.map((row) => {
    const values = Array.isArray(row) ? row : []
    const match = String(values[0] || '').match(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/,
    )
    if (!match) throw new Error('腾讯分钟时间格式无效')
    return [
      `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:00`,
      values[1],
      values[2],
      values[3],
      values[4],
      values[5],
    ]
  }))
}

export async function fetchFiveMinuteBars(code, {
  fetchImpl = fetch,
  timeoutMs = 6000,
  limit = 240,
  completedWindowOnly = true,
  adjustment = 'qfq',
} = {}) {
  const normalizedCode = String(code || '').trim()
  if (!CODE_RE.test(normalizedCode)) {
    throw new Error('股票代码无效')
  }
  if (!['qfq', 'raw'].includes(adjustment)) {
    throw new Error('分钟复权口径无效')
  }
  const requestLimit = Math.max(
    61,
    Math.min(1200, Number(limit) || 240),
  )
  const path =
    `/api/qt/stock/kline/get?secid=${marketSecid(normalizedCode)}`
    + '&fields1=f1,f2,f3,f4,f5,f6'
    + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
    + `&klt=5&fqt=${adjustment === 'raw' ? 0 : 1}`
    + `&end=20500101&lmt=${requestLimit}`
  for (const host of MINUTE_HOSTS) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(host + path, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://quote.eastmoney.com/',
        },
      })
      if (!response.ok) continue
      const json = await response.json()
      const lines = json?.data?.klines
      if (!Array.isArray(lines) || !lines.length) continue
      const parsed = parseFiveMinuteKlines(lines)
      return completedWindowOnly
        ? selectCompletedDayEndBars(parsed)
        : parsed
    } catch {
      // 换下一镜像。
    } finally {
      clearTimeout(timeout)
    }
  }

  const txCode = tencentCode(normalizedCode)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(
      `${TENCENT_MINUTE_HOST}/appstock/app/kline/mkline`
        + `?param=${txCode},m5,,${requestLimit}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://gu.qq.com/',
        },
      },
    )
    if (response.ok) {
      const json = await response.json()
      const parsed = parseTencentFiveMinuteKlines(
        json?.data?.[txCode]?.m5,
      )
      if (parsed.length) {
        return completedWindowOnly
          ? selectCompletedDayEndBars(parsed)
          : parsed
      }
    }
  } catch {
    // 所有公开分钟源都不可用时由调用方明确降级。
  } finally {
    clearTimeout(timeout)
  }
  throw new Error('分钟行情暂不可用')
}
