import { randomUUID } from 'node:crypto'
import {
  adaptV2Prediction,
  adaptV21Prediction,
} from '../shared/modelVersion.js'
import { getV2RuntimeConfig } from './_quant_model_control.js'

const CODE_RE = /^\d{6}$/
const EAS_HOST_RE = /(^|\.)pai-eas\.aliyuncs\.com$/i
let runtimeConfigOverride = null
const MINUTE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://82.push2his.eastmoney.com',
  'https://48.push2his.eastmoney.com',
]
const TENCENT_MINUTE_HOST = 'https://ifzq.gtimg.cn'

function number(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`V2分钟数据${name}无效`)
  return parsed
}

function normalizeTime(value) {
  const text = String(value || '').trim().replace('T', ' ')
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return `${text}:00`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text
  throw new Error('V2分钟时间格式无效')
}

export function parseFiveMinuteKlines(lines) {
  if (!Array.isArray(lines)) throw new Error('V2分钟K线格式无效')
  return lines.map((line) => {
    const values = Array.isArray(line) ? line : String(line || '').split(',')
    if (values.length < 6) throw new Error('V2分钟K线字段不足')
    const open = number(values[1], '开盘价')
    const close = number(values[2], '收盘价')
    const high = number(values[3], '最高价')
    const low = number(values[4], '最低价')
    const volume = number(values[5], '成交量')
    if (
      open <= 0 || close <= 0 || low <= 0 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      volume < 0
    ) throw new Error('V2分钟OHLCV约束无效')
    return {
      tradeTime: normalizeTime(values[0]),
      open, high, low, close, volume,
    }
  }).sort((a, b) => a.tradeTime.localeCompare(b.tradeTime))
}

export function selectCompletedDayEndBars(bars, minimum = 61) {
  if (!Array.isArray(bars)) throw new Error('V2分钟K线格式无效')
  let closeIndex = -1
  for (let index = bars.length - 1; index >= 0; index--) {
    if (String(bars[index]?.tradeTime || '').endsWith('15:00:00')) {
      closeIndex = index
      break
    }
  }
  if (closeIndex < 0) throw new Error('V2分钟数据缺少完整收盘窗口')
  const completed = bars.slice(0, closeIndex + 1)
  if (completed.length < minimum) throw new Error('V2完整分钟窗口不足')
  return completed.slice(-Math.max(minimum, 240))
}

function marketSecid(code) {
  return `${/^(6|9|5)/.test(code) ? '1' : '0'}.${code}`
}

function tencentCode(code) {
  return `${/^(6|9|5)/.test(code) ? 'sh' : 'sz'}${code}`
}

function parseTencentFiveMinuteKlines(rows) {
  if (!Array.isArray(rows)) throw new Error('V2腾讯分钟K线格式无效')
  return parseFiveMinuteKlines(rows.map((row) => {
    const values = Array.isArray(row) ? row : []
    const match = String(values[0] || '').match(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/,
    )
    if (!match) throw new Error('V2腾讯分钟时间格式无效')
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
} = {}) {
  code = String(code || '').trim()
  if (!CODE_RE.test(code)) throw new Error('V2股票代码无效')
  const requestLimit = Math.max(
    61,
    Math.min(1200, Number(limit) || 240),
  )
  const path = `/api/qt/stock/kline/get?secid=${marketSecid(code)}`
    + '&fields1=f1,f2,f3,f4,f5,f6'
    + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
    + `&klt=5&fqt=1&end=20500101&lmt=${requestLimit}`
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
      return completedWindowOnly ? selectCompletedDayEndBars(parsed) : parsed
    } catch {
      // 换下一镜像。
    } finally {
      clearTimeout(timeout)
    }
  }
  const txCode = tencentCode(code)
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
  throw new Error('V2分钟行情暂不可用')
}

function exchangeCode(code) {
  return /^(6|9|5)/.test(code) ? `${code}.SH` : `${code}.SZ`
}

function rounded(value, digits = 3) {
  return +Number(value).toFixed(digits)
}

function roundedPrice(value) {
  return rounded(value, Number(value) < 10 ? 3 : 2)
}

export function deriveV2MarketContext(bars) {
  const ordered = selectCompletedDayEndBars(bars)
  const signalDate = ordered.at(-1).tradeTime.slice(0, 10)
  const session = ordered.filter(
    (bar) => bar.tradeTime.slice(0, 10) === signalDate,
  )
  const first = session[0]
  const last = session.at(-1)
  const highs = session.map((bar) => bar.high)
  const lows = session.map((bar) => bar.low)
  const closes = session.map((bar) => bar.close)
  const volumes = session.map((bar) => bar.volume)
  const recent = session.slice(-20)
  const dayHigh = Math.max(...highs)
  const dayLow = Math.min(...lows)
  const returns = closes.slice(1).map(
    (close, index) => Math.log(close / closes[index]),
  )
  const meanReturn = returns.reduce((sum, value) => sum + value, 0)
    / Math.max(1, returns.length)
  const returnVariance = returns.reduce(
    (sum, value) => sum + (value - meanReturn) ** 2,
    0,
  ) / Math.max(1, returns.length)
  const rangeValues = session.map(
    (bar) => (bar.high - bar.low) / bar.close * 100,
  )
  const baselineVolumes = volumes.slice(-20, -1)
  const baseline = baselineVolumes.reduce((sum, value) => sum + value, 0)
    / Math.max(1, baselineVolumes.length)
  const ma = (length) => {
    const values = closes.slice(-length)
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }
  const ma5 = ma(5)
  const ma20 = ma(20)
  const trendAlignment = last.close >= ma5 && ma5 >= ma20
    ? 'bullish'
    : last.close <= ma5 && ma5 <= ma20 ? 'bearish' : 'mixed'
  const supportPrice = roundedPrice(Math.min(...recent.map((bar) => bar.low)))
  const resistancePrice = roundedPrice(Math.max(...recent.map((bar) => bar.high)))
  const momentumReference = session.length >= 7
    ? session.at(-7).close
    : first.open
  const span = dayHigh - dayLow
  return {
    barsCount: ordered.length,
    sessionBars: session.length,
    sessionReturnPct: rounded((last.close / first.open - 1) * 100),
    momentum30mPct: rounded(
      (last.close / momentumReference - 1) * 100,
    ),
    realizedVolPct: rounded(
      Math.sqrt(returnVariance) * Math.sqrt(Math.max(1, returns.length)) * 100,
    ),
    averageRangePct: rounded(
      rangeValues.reduce((sum, value) => sum + value, 0)
        / Math.max(1, rangeValues.length),
    ),
    volumeRatio20: rounded(baseline > 0 ? last.volume / baseline : 1),
    closeLocationPct: rounded(
      span > 0 ? (last.close - dayLow) / span * 100 : 50,
      2,
    ),
    drawdownFromHighPct: rounded((last.close / dayHigh - 1) * 100),
    reboundFromLowPct: rounded((last.close / dayLow - 1) * 100),
    supportPrice,
    resistancePrice,
    trendAlignment,
  }
}

export function deriveV2PriceReferences(bars, context) {
  const anchorPrice = roundedPrice(selectCompletedDayEndBars(bars).at(-1).close)
  const supportPrice = context.supportPrice
  return {
    anchorType: 'signalClose',
    anchorPrice,
    supportPrice,
    resistancePrice: context.resistancePrice,
    referenceBuyZoneLow: roundedPrice(Math.min(supportPrice, anchorPrice)),
    referenceBuyZoneHigh: roundedPrice(Math.max(supportPrice, anchorPrice)),
    indicativeTakeProfitPrice: roundedPrice(anchorPrice * 1.01),
    indicativeStopLossPrice: roundedPrice(anchorPrice * 0.994),
    provisional: true,
    note: '基于信号日收盘与5分钟支撑压力的参考锚点，实际入场须按下一交易日首根5分钟开盘修正',
  }
}

export function v2ExecutionHorizon(context = {}) {
  const phase = String(context.phase || '')
  if (context.tradingToday && /午间/.test(phase)) {
    return '今天下午13:00-15:00'
  }
  if (!context.tradingToday || /盘后|^休市/.test(phase)) {
    return context.nextTradingDayLabel
      ? `下一交易日（${context.nextTradingDayLabel}）`
      : '下一交易日'
  }
  if (/早盘|午盘/.test(phase)) return '今日15:00收盘前'
  return '今日交易时段'
}

export function v2ForecastHorizon(context = {}, signalAsOf = '') {
  const phase = String(context.phase || '')
  const today = String(context.bjNow || '').slice(0, 10)
  const signalDate = String(signalAsOf || '').slice(0, 10)
  const signalIsToday = !!today && signalDate === today
  if (!context.tradingToday || /盘后|^休市/.test(phase) || signalIsToday) {
    return context.nextTradingDayLabel
      ? `下一交易日（${context.nextTradingDayLabel}）`
      : '下一交易日'
  }
  return '今日交易日（基于上一收盘信号）'
}

export function deriveV2SessionExecutionReference(
  bars,
  prediction,
  context = {},
) {
  if (!context.tradingToday || !context.isLive || !Array.isArray(bars)) {
    return null
  }
  const today = String(context.bjNow || '').slice(0, 10)
  const session = bars
    .filter((bar) => String(bar?.tradeTime || '').slice(0, 10) === today)
    .sort((a, b) => a.tradeTime.localeCompare(b.tradeTime))
  if (session.length < 3) return null

  const latest = session.at(-1)
  const recent = session.slice(-20)
  const closes = session.map((bar) => bar.close)
  const volumes = session.map((bar) => bar.volume)
  const volumeTotal = volumes.reduce((sum, value) => sum + value, 0)
  const vwap = volumeTotal > 0
    ? session.reduce((sum, bar) => sum + bar.close * bar.volume, 0)
      / volumeTotal
    : latest.close
  const rangePct = recent.reduce(
    (sum, bar) => sum + (bar.high - bar.low) / bar.close * 100,
    0,
  ) / recent.length
  const momentumRef = closes.length >= 7 ? closes.at(-7) : closes[0]
  const momentum30mPct = (latest.close / momentumRef - 1) * 100
  const phase = String(context.phase || '')
  const timeMatch = String(context.bjNow || '').match(/(\d{2}):(\d{2})/)
  const minute = timeMatch
    ? Number(timeMatch[1]) * 60 + Number(timeMatch[2])
    : null
  const remainingMinutes = /午间/.test(phase)
    ? 120
    : /早盘/.test(phase) && minute != null
      ? Math.max(0, 690 - minute) + 120
      : /午盘/.test(phase) && minute != null
        ? Math.max(0, 900 - minute)
        : 60
  const remainingBars = Math.max(1, Math.ceil(remainingMinutes / 5))
  const projectedPct = Math.max(
    0.35,
    Math.min(2.5, rangePct * Math.sqrt(Math.max(1, remainingBars) / 6)),
  )
  const direction = String(prediction?.forecast?.direction || '')
  const modelTilt = direction === '看涨'
    ? projectedPct * 0.18
    : direction === '看跌' ? -projectedPct * 0.18 : 0
  const momentumTilt = Math.max(
    -projectedPct * 0.25,
    Math.min(projectedPct * 0.25, momentum30mPct * 0.3),
  )
  const center = latest.close * (1 + (modelTilt + momentumTilt) / 100)
  const support = Math.min(...recent.map((bar) => bar.low))
  const resistance = Math.max(...recent.map((bar) => bar.high))
  const rangeLow = Math.min(
    latest.close,
    vwap,
    support,
    center * (1 - projectedPct / 100),
  )
  const rangeHigh = Math.max(
    latest.close,
    vwap,
    resistance,
    center * (1 + projectedPct / 100),
  )
  const digits = latest.close < 10 ? 3 : 2
  const roundPrice = (value) => +Number(value).toFixed(digits)

  return {
    kind: 'realtime-execution-reference',
    modelProbability: false,
    horizon: v2ExecutionHorizon(context),
    asOf: latest.tradeTime,
    anchorPrice: roundPrice(latest.close),
    vwap: roundPrice(vwap),
    momentum30mPct: rounded(momentum30mPct),
    rangeLow: roundPrice(rangeLow),
    rangeHigh: roundPrice(rangeHigh),
    supportPrice: roundPrice(support),
    resistancePrice: roundPrice(resistance),
    modelDirection: direction || '未知',
    note: '基于当日已发生的真实5分钟行情修正执行区间，不是新的模型概率，也不计入V2正确率',
  }
}

export function buildV2Request(code, bars, requestId = '') {
  code = String(code || '').trim()
  if (!CODE_RE.test(code)) throw new Error('V2股票代码无效')
  if (!Array.isArray(bars) || bars.length < 61) throw new Error('V2至少需要61根5分钟K线')
  const ordered = bars.slice().sort((a, b) => a.tradeTime.localeCompare(b.tradeTime))
  const asOf = ordered.at(-1).tradeTime
  if (!asOf.endsWith('15:00:00')) throw new Error('V2仅接受15:00日终序列')
  const day = asOf.slice(0, 10).replaceAll('-', '')
  return {
    requestId: requestId || `shadow_${day}_${code}`,
    code: exchangeCode(code),
    asOf,
    bars: ordered,
  }
}

function completedFiveMinuteCutoff(bjNow) {
  const match = String(bjNow || '').match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/,
  )
  if (!match) return null
  const total = Number(match[2]) * 60 + Number(match[3])
  const completed = Math.floor((total - 1) / 5) * 5
  return {
    date: match[1],
    hhmm: `${String(Math.floor(completed / 60)).padStart(2, '0')}:${String(completed % 60).padStart(2, '0')}`,
  }
}

export function selectV21IntradayBars(bars, context = {}) {
  if (!Array.isArray(bars) || !context.tradingToday) return []
  const current = completedFiveMinuteCutoff(context.bjNow)
  if (!current) return []
  let cutoff = current.hhmm
  if (String(context.phase).includes('午间')) cutoff = '11:30'
  if (String(context.phase).includes('午盘') && cutoff > '14:30') {
    cutoff = '14:30'
  }
  if (String(context.phase).includes('早盘') && cutoff > '11:30') {
    cutoff = '11:30'
  }
  const supported = (
    ('10:00' <= cutoff && cutoff <= '11:30')
    || ('13:05' <= cutoff && cutoff <= '14:30')
  )
  if (!supported) return []
  const asOf = `${current.date} ${cutoff}:00`
  const selected = bars
    .filter((bar) => String(bar?.tradeTime || '') <= asOf)
    .slice(-240)
  if (
    selected.length < 60
    || !String(selected.at(-1)?.tradeTime || '').startsWith(
      `${current.date} ${cutoff}`,
    )
  ) return []
  return selected
}

export function buildV21Request(code, bars, requestId = '') {
  code = String(code || '').trim()
  if (!CODE_RE.test(code)) throw new Error('V2.1股票代码无效')
  if (!Array.isArray(bars) || bars.length < 60) {
    throw new Error('V2.1至少需要60根5分钟K线')
  }
  const ordered = bars.slice(-240)
    .sort((left, right) => left.tradeTime.localeCompare(right.tradeTime))
  const asOf = ordered.at(-1).tradeTime
  const stamp = asOf.replace(/\D/g, '').slice(0, 12)
  return {
    requestId: requestId || `v21_${stamp}_${code}`,
    code: exchangeCode(code),
    asOf,
    bars: ordered,
  }
}

function v2Config(env) {
  const url = String(env.V2_QUANT_URL || '').trim().replace(/\/+$/, '')
  const easToken = String(env.V2_EAS_TOKEN || '')
  const apiKey = String(env.V2_API_KEY || '')
  if (!url || !easToken || !apiKey) throw new Error('V2模型服务未配置')
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('V2模型服务地址无效') }
  if (parsed.protocol !== 'https:' || !EAS_HOST_RE.test(parsed.hostname)) {
    throw new Error('V2模型服务地址必须为阿里云EAS HTTPS地址')
  }
  return { url, easToken, apiKey }
}

export async function fetchV21QuantPredict(code, {
  bars,
  requestId = '',
  price = null,
  activeHead = 'next30m',
  env = process.env,
  fetchImpl = fetch,
  resolveRuntimeConfig = getV2RuntimeConfig,
  timeoutMs = 8000,
} = {}) {
  let config = env === process.env && runtimeConfigOverride
    ? v2Config({
        ...env,
        V2_QUANT_URL: runtimeConfigOverride.url,
        V2_EAS_TOKEN: runtimeConfigOverride.easToken,
      })
    : v2Config(env)
  const payload = buildV21Request(code, bars, requestId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const request = (activeConfig) => fetchImpl(
      `${activeConfig.url}/predict-v2-intraday`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: activeConfig.easToken,
          'X-Shadow-Key': activeConfig.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    )
    let response = await request(config)
    if (response.status === 401 && typeof resolveRuntimeConfig === 'function') {
      try {
        const runtime = await resolveRuntimeConfig()
        const recovered = v2Config({
          ...env,
          V2_QUANT_URL: runtime.url,
          V2_EAS_TOKEN: runtime.easToken,
        })
        if (
          runtime?.status === 'Running'
          && (
            recovered.url !== config.url
            || recovered.easToken !== config.easToken
          )
        ) {
          config = recovered
          response = await request(config)
        }
      } catch {
        // Preserve the inference response when control-plane recovery fails.
      }
    }
    if (!response.ok) throw new Error(`V2.1模型服务返回${response.status}`)
    return adaptV21Prediction(await response.json(), {
      price,
      activeHead,
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchV2QuantPredict(code, {
  bars,
  requestId = '',
  price = null,
  env = process.env,
  fetchImpl = fetch,
  resolveRuntimeConfig = getV2RuntimeConfig,
  timeoutMs = 8000,
} = {}) {
  let config = env === process.env && runtimeConfigOverride
    ? v2Config({
        ...env,
        V2_QUANT_URL: runtimeConfigOverride.url,
        V2_EAS_TOKEN: runtimeConfigOverride.easToken,
      })
    : v2Config(env)
  const payload = buildV2Request(
    code,
    selectCompletedDayEndBars(bars),
    requestId || `shadow_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  )
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const request = (activeConfig) => fetchImpl(`${activeConfig.url}/predict-v2`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: activeConfig.easToken,
        'X-Shadow-Key': activeConfig.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    let response = await request(config)
    if (response.status === 401 && typeof resolveRuntimeConfig === 'function') {
      try {
        const runtime = await resolveRuntimeConfig()
        if (runtime?.status === 'Running') {
          const recoveredConfig = v2Config({
            ...env,
            V2_QUANT_URL: runtime.url,
            V2_EAS_TOKEN: runtime.easToken,
          })
          if (
            recoveredConfig.url !== config.url
            || recoveredConfig.easToken !== config.easToken
          ) {
            config = recoveredConfig
            response = await request(config)
            if (env === process.env && response.ok) {
              runtimeConfigOverride = {
                url: config.url,
                easToken: config.easToken,
              }
            }
          }
        }
      } catch {
        // Keep the original inference error when control-plane recovery fails.
      }
    }
    if (!response.ok) throw new Error(`V2模型服务返回${response.status}`)
    const prediction = await response.json()
    const context = prediction.marketContext || deriveV2MarketContext(payload.bars)
    const priceReferences = prediction.priceReferences
      || deriveV2PriceReferences(payload.bars, context)
    return adaptV2Prediction({
      ...prediction,
      marketContext: context,
      priceReferences,
    }, { price })
  } finally {
    clearTimeout(timeout)
  }
}
