import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildV2Request,
  fetchFiveMinuteBars,
  fetchV2QuantPredict,
  parseFiveMinuteKlines,
  selectCompletedDayEndBars,
} from '../api/_v2_quant.js'
import { fetchSelectedQuantPredict } from '../api/_ta.js'

function minuteLines() {
  const rows = []
  for (let index = 0; index < 60; index++) {
    const total = 10 * 60 + index * 5
    const hh = String(Math.floor(total / 60)).padStart(2, '0')
    const mm = String(total % 60).padStart(2, '0')
    rows.push(`2026-08-10 ${hh}:${mm},10,10,10.1,9.9,${1000 + index},10000`)
  }
  rows.push('2026-08-10 15:00,10,10,10.1,9.9,1100,11000')
  return rows
}

test('解析真实5分钟OHLCV并构造V2日终请求', () => {
  const bars = parseFiveMinuteKlines(minuteLines())
  const request = buildV2Request('600519', bars)

  assert.equal(bars.length, 61)
  assert.equal(bars.at(-1).tradeTime, '2026-08-10 15:00:00')
  assert.equal(request.code, '600519.SH')
  assert.equal(request.asOf, '2026-08-10 15:00:00')
  assert.equal(request.requestId, 'shadow_20260810_600519')
  assert.equal(request.bars.length, 61)
})

test('盘中分钟线只截取最近一个完整15点窗口', () => {
  const previous = minuteLines().map((line) => line.replaceAll('2026-08-10', '2026-08-07'))
  const current = minuteLines().slice(0, 20)
  const selected = selectCompletedDayEndBars(
    parseFiveMinuteKlines([...previous, ...current]),
  )

  assert.equal(selected.length, 61)
  assert.equal(selected.at(-1).tradeTime, '2026-08-07 15:00:00')
})

test('分钟行情下载校验代码并回退多镜像', async () => {
  const calls = []
  const bars = await fetchFiveMinuteBars('600519', {
    fetchImpl: async (url) => {
      calls.push(url)
      if (calls.length === 1) throw new Error('primary unavailable')
      return {
        ok: true,
        async json() {
          return { data: { klines: minuteLines() } }
        },
      }
    },
  })

  assert.equal(calls.length, 2)
  assert.equal(bars.length, 61)
  assert.equal(bars.at(-1).tradeTime, '2026-08-10 15:00:00')
})

test('东财分钟镜像全部失败后回退腾讯真实5分钟K线', async () => {
  const calls = []
  const tencentRows = minuteLines().map((line) => {
    const values = line.split(',')
    const time = values[0].replaceAll('-', '').replaceAll(' ', '').replaceAll(':', '')
    return [
      time,
      values[1],
      values[2],
      values[3],
      values[4],
      values[5],
      {},
    ]
  })
  const bars = await fetchFiveMinuteBars('600519', {
    fetchImpl: async (url) => {
      calls.push(url)
      if (!url.startsWith('https://ifzq.gtimg.cn/')) {
        throw new Error('eastmoney unavailable')
      }
      return {
        ok: true,
        async json() {
          return { data: { sh600519: { m5: tencentRows } } }
        },
      }
    },
  })

  assert.equal(calls.length, 4)
  assert.match(calls.at(-1), /ifzq\.gtimg\.cn/)
  assert.equal(bars.length, 61)
  assert.equal(bars.at(-1).tradeTime, '2026-08-10 15:00:00')
  assert.equal(bars[0].volume, 1000)
})

test('V2客户端携带双层鉴权并返回统一量化结构', async () => {
  let captured = null
  const result = await fetchV2QuantPredict('600519', {
    bars: parseFiveMinuteKlines(minuteLines()),
    env: {
      V2_QUANT_URL: 'https://123.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
      V2_EAS_TOKEN: 'eas-token',
      V2_API_KEY: 'shadow-key',
    },
    fetchImpl: async (url, options) => {
      captured = { url, options }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            shadowOnly: true,
            asOf: '2026-08-10 15:00:00',
            predictedClass: 'TAKE_PROFIT',
            probabilities: { stopLoss: 0.2, timeout: 0.1, takeProfit: 0.7 },
            outlook: {
              direction: 'bullish',
              confidencePct: 70,
              probabilityMarginPct: 50,
              expectedBarrierReturnPct: 0.58,
              directionScore: 75,
              riskLevel: 'medium',
              signalStrength: 'strong',
            },
            model: { runId: 'run-v2', architecture: 'transformer', sha256: 'a'.repeat(64) },
          }
        },
      }
    },
  })

  assert.equal(captured.url.endsWith('/predict-v2'), true)
  assert.equal(captured.options.headers.Authorization, 'eas-token')
  assert.equal(captured.options.headers['X-Shadow-Key'], 'shadow-key')
  assert.equal(result.modelVersion, 'v2')
  assert.equal(result.forecast.upProb, 70)
  assert.equal(result.v2.predictedClass, 'TAKE_PROFIT')
  assert.equal(result.v2.marketContext.barsCount, 61)
  assert.equal(result.v2.priceReferences.anchorPrice, 10)
  assert.equal(result.v2.priceReferences.supportPrice, 9.9)
  assert.equal(result.v2.priceReferences.resistancePrice, 10.1)
  assert.equal(result.v2.priceReferences.indicativeTakeProfitPrice, 10.1)
  assert.equal(result.v2.priceReferences.indicativeStopLossPrice, 9.94)
  assert.notEqual(result.v2.outlook.uncertaintyLevel, 'unknown')
  assert.equal(Number.isFinite(result.v2.outlook.convictionScore), true)
})

test('V2客户端拒绝非阿里云EAS地址和缺失密钥', async () => {
  const bars = parseFiveMinuteKlines(minuteLines())
  await assert.rejects(
    () => fetchV2QuantPredict('600519', {
      bars,
      env: {
        V2_QUANT_URL: 'https://example.com/model',
        V2_EAS_TOKEN: 'token',
        V2_API_KEY: 'key',
      },
    }),
    /地址/,
  )
  await assert.rejects(
    () => fetchV2QuantPredict('600519', {
      bars,
      env: { V2_QUANT_URL: 'https://123.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/test' },
    }),
    /未配置/,
  )
})

test('选择V2后预测不可用必须明确失败而不是静默返回空', async () => {
  const candles = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    open: 10,
    close: 10,
    high: 10.1,
    low: 9.9,
    volume: 1000,
  }))

  await assert.rejects(
    () => fetchSelectedQuantPredict(
      'v2',
      '600519',
      candles,
      null,
      1000,
      null,
      {
        fetchBars: async () => parseFiveMinuteKlines(minuteLines()),
        fetchV2: async () => null,
      },
    ),
    /V2模型服务未运行或预测不可用/,
  )
})
