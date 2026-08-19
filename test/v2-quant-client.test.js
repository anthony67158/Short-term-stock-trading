import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildV2Request,
  buildV21Request,
  deriveV2SessionExecutionReference,
  fetchFiveMinuteBars,
  fetchV2QuantPredict,
  fetchV21QuantPredict,
  parseFiveMinuteKlines,
  selectCompletedDayEndBars,
  selectV21IntradayBars,
  v2ExecutionHorizon,
  v2ForecastHorizon,
} from '../api/_v2_quant.js'
import {
  fetchSelectedQuantPredict,
  mergeLatestMinuteSessionIntoDailyCandles,
} from '../api/_ta.js'

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

function validSessionLines(date, cutoff = '15:00') {
  const rows = []
  const pushRange = (start, end) => {
    for (let total = start; total <= end; total += 5) {
      const hh = String(Math.floor(total / 60)).padStart(2, '0')
      const mm = String(total % 60).padStart(2, '0')
      const hm = `${hh}:${mm}`
      if (hm > cutoff) return
      rows.push(`${date} ${hm},10,10,10.1,9.9,1000,10000`)
    }
  }
  pushRange(9 * 60 + 35, 11 * 60 + 30)
  pushRange(13 * 60 + 5, 15 * 60)
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

test('V2预测前优先同步EAS当前运行配置', async () => {
  const calls = []
  const result = await fetchV2QuantPredict('600519', {
    bars: parseFiveMinuteKlines(minuteLines()),
    env: {
      V2_QUANT_URL: 'https://old.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
      V2_EAS_TOKEN: 'current-token',
      V2_API_KEY: 'shadow-key',
    },
    resolveRuntimeConfig: async () => ({
      url: 'https://current.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
      easToken: 'current-token',
      status: 'Running',
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization })
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
            outlook: { direction: 'bullish' },
            model: { runId: 'run-v2', architecture: 'transformer', sha256: 'a'.repeat(64) },
          }
        },
      }
    },
  })

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /current\.cn-hangzhou/)
  assert.equal(calls[0].authorization, 'current-token')
  assert.equal(result.modelVersion, 'v2')
})

test('V2网关拒绝旧运行配置时刷新后重试', async () => {
  const calls = []
  let runtimeReads = 0
  const result = await fetchV2QuantPredict('600519', {
    bars: parseFiveMinuteKlines(minuteLines()),
    env: {
      V2_QUANT_URL: 'https://old.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
      V2_EAS_TOKEN: 'old-token',
      V2_API_KEY: 'shadow-key',
    },
    resolveRuntimeConfig: async () => {
      runtimeReads++
      return runtimeReads === 1
        ? {
            url: 'https://old.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
            easToken: 'old-token',
            apiKey: 'shadow-key',
            status: 'Running',
          }
        : {
            url: 'https://current.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
            easToken: 'current-token',
            apiKey: 'shadow-key',
            status: 'Running',
          }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization })
      if (url.includes('old.cn-hangzhou')) {
        return { ok: false, status: 403 }
      }
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
            outlook: { direction: 'bullish' },
            model: { runId: 'run-v2', architecture: 'transformer', sha256: 'a'.repeat(64) },
          }
        },
      }
    },
  })

  assert.equal(runtimeReads, 2)
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /current\.cn-hangzhou/)
  assert.equal(calls[1].authorization, 'current-token')
  assert.equal(result.modelVersion, 'v2')
})

test('V2静态配置缺失时自动使用EAS当前运行配置', async () => {
  let captured = null
  const result = await fetchV2QuantPredict('600519', {
    bars: parseFiveMinuteKlines(minuteLines()),
    env: {},
    resolveRuntimeConfig: async () => ({
      url: 'https://current.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
      easToken: 'current-token',
      apiKey: 'current-shadow-key',
      status: 'Running',
    }),
    fetchImpl: async (url, options) => {
      captured = { url, headers: options.headers }
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
            outlook: { direction: 'bullish' },
            model: { runId: 'run-v2', architecture: 'transformer', sha256: 'a'.repeat(64) },
          }
        },
      }
    },
  })

  assert.match(captured.url, /current\.cn-hangzhou/)
  assert.equal(captured.headers.Authorization, 'current-token')
  assert.equal(captured.headers['X-Shadow-Key'], 'current-shadow-key')
  assert.equal(result.modelVersion, 'v2')
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

test('生产模型用最新已完成五分钟K聚合更新当天日线OHLCV', () => {
  const daily = [
    {
      date: '2026-08-18',
      open: 10,
      high: 10.4,
      low: 9.8,
      close: 10.2,
      volume: 1000,
      pct: 1,
    },
    {
      date: '2026-08-19',
      open: 10.2,
      high: 10.3,
      low: 10.1,
      close: 10.2,
      volume: 100,
      pct: 0,
    },
  ]
  const minute = [
    {
      tradeTime: '2026-08-19 09:35:00',
      open: 10.2,
      high: 10.5,
      low: 10.1,
      close: 10.4,
      volume: 300,
    },
    {
      tradeTime: '2026-08-19 09:40:00',
      open: 10.4,
      high: 10.8,
      low: 10.3,
      close: 10.7,
      volume: 500,
    },
    {
      tradeTime: '2026-08-19 09:45:00',
      open: 10.7,
      high: 11,
      low: 10.6,
      close: 10.9,
      volume: 700,
    },
  ]

  const merged = mergeLatestMinuteSessionIntoDailyCandles(
    daily,
    minute,
    {
      tradingToday: true,
      isLive: true,
      phase: '早盘(盘中)',
      bjNow: '2026-08-19 09:47',
    },
  )

  assert.equal(merged.inputAsOf, '2026-08-19 09:45:00')
  assert.equal(merged.inputSource, 'completed-5m-aggregated')
  assert.deepEqual(merged.candles.at(-1), {
    date: '2026-08-19',
    open: 10.2,
    high: 11,
    low: 10.1,
    close: 10.9,
    volume: 1500,
    pct: 6.86,
  })
})

test('生产模型选择器把最新分时聚合日线送入原36因子模型', async () => {
  const daily = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume: 1000,
  }))
  daily.push({
    date: '2026-08-19',
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 50,
  })
  const bars = [
    {
      tradeTime: '2026-08-19 09:35:00',
      open: 10,
      high: 10.4,
      low: 9.9,
      close: 10.3,
      volume: 400,
    },
    {
      tradeTime: '2026-08-19 09:40:00',
      open: 10.3,
      high: 10.6,
      low: 10.2,
      close: 10.5,
      volume: 600,
    },
  ]
  let received = null

  const result = await fetchSelectedQuantPredict(
    'default',
    '600519',
    daily,
    null,
    1000,
    { price: 10.55, live: true },
    {
      fetchBars: async () => bars,
      fetchDefault: async (
        _code,
        candles,
        _hold,
        _timeout,
        realtime,
      ) => {
        received = { candles, realtime }
        return {
          ok: true,
          modelVersion: 'default',
          asOf: '2026-08-19',
        }
      },
      timeContext: {
        tradingToday: true,
        isLive: true,
        phase: '早盘(盘中)',
        bjNow: '2026-08-19 09:42',
      },
      refreshDailyFromMinutes: true,
    },
  )

  assert.equal(received.candles.at(-1).close, 10.5)
  assert.equal(received.candles.at(-1).volume, 1000)
  assert.equal(result.inputAsOf, '2026-08-19 09:40:00')
  assert.equal(result.inputSource, 'completed-5m-aggregated')
})

test('非军师生产量化保持原日线快路径不额外下载分钟线', async () => {
  let minuteCalls = 0
  const candles = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume: 1000,
  }))

  const result = await fetchSelectedQuantPredict(
    'default',
    '600519',
    candles,
    null,
    1000,
    null,
    {
      fetchBars: async () => {
        minuteCalls++
        return []
      },
      fetchDefault: async () => ({
        ok: true,
        modelVersion: 'default',
        asOf: '2026-07-30',
      }),
    },
  )

  assert.equal(minuteCalls, 0)
  assert.equal(result.inputSource, 'daily-kline')
})

test('V2展示时段随市场阶段变化但不篡改训练标签', () => {
  assert.equal(v2ForecastHorizon({
    tradingToday: true,
    phase: '早盘(盘中)',
    bjNow: '2026-08-12 10:00',
    nextTradingDayLabel: '2026-08-13(周四)',
  }, '2026-08-11 15:00:00'), '今日交易日（基于上一收盘信号）')
  assert.equal(v2ForecastHorizon({
    tradingToday: true,
    phase: '午间休市',
    bjNow: '2026-08-12 12:00',
    nextTradingDayLabel: '2026-08-13(周四)',
  }, '2026-08-11 15:00:00'), '今日交易日（基于上一收盘信号）')
  assert.equal(v2ExecutionHorizon({
    tradingToday: true,
    phase: '午间休市',
  }), '今天下午13:00-15:00')
  assert.equal(v2ForecastHorizon({
    tradingToday: true,
    phase: '盘后(已收盘)',
    bjNow: '2026-08-12 15:30',
    nextTradingDayLabel: '2026-08-13(周四)',
  }, '2026-08-12 15:00:00'), '下一交易日（2026-08-13(周四)）')
})

test('午间使用今日真实5分钟行情生成下午执行区间', () => {
  const bars = parseFiveMinuteKlines(
    minuteLines()
      .slice(0, 20)
      .map((line) => line.replaceAll('2026-08-10', '2026-08-12')),
  )
  const reference = deriveV2SessionExecutionReference(bars, {
    forecast: { direction: '看涨' },
  }, {
    tradingToday: true,
    isLive: true,
    phase: '午间休市',
    bjNow: '2026-08-12 12:00',
  })

  assert.equal(reference.horizon, '今天下午13:00-15:00')
  assert.equal(reference.kind, 'realtime-execution-reference')
  assert.equal(reference.modelProbability, false)
  assert.ok(reference.rangeLow < reference.rangeHigh)
  assert.ok(reference.anchorPrice >= reference.rangeLow)
  assert.ok(reference.anchorPrice <= reference.rangeHigh)
})

test('V2选择器同时返回原模型预测和当前时段执行参考', async () => {
  let fetchOptions = null
  const bars = parseFiveMinuteKlines([
    ...minuteLines().map((line) => line.replaceAll('2026-08-10', '2026-08-11')),
    ...minuteLines().slice(0, 20).map((line) => line.replaceAll('2026-08-10', '2026-08-12')),
  ])
  const result = await fetchSelectedQuantPredict(
    'v2',
    '600519',
    [],
    null,
    1000,
    null,
    {
      fetchBars: async (_code, options) => {
        fetchOptions = options
        return bars
      },
      fetchV2: async () => ({
        ok: true,
        modelVersion: 'v2',
        forecast: {
          direction: '看涨',
          horizon: '下一交易日',
          upProb: 62,
        },
        v2: {},
        reads: [],
      }),
      timeContext: {
        tradingToday: true,
        isLive: true,
        phase: '午间休市',
        bjNow: '2026-08-12 12:00',
        nextTradingDayLabel: '2026-08-13(周四)',
      },
    },
  )

  assert.equal(fetchOptions.completedWindowOnly, false)
  assert.equal(result.forecast.horizon, '今日交易日（基于上一收盘信号）')
  assert.equal(result.v2.targetDefinition, undefined)
  assert.equal(result.v2.executionReference.horizon, '今天下午13:00-15:00')
  assert.equal(result.v2.executionReference.modelProbability, false)
})

test('V2.1盘中序列按最近已完成5分钟K线截断', () => {
  const bars = parseFiveMinuteKlines([
    ...validSessionLines('2026-08-11'),
    ...validSessionLines('2026-08-12', '10:35'),
  ])

  const morning = selectV21IntradayBars(bars, {
    tradingToday: true,
    phase: '早盘(盘中)',
    bjNow: '2026-08-12 10:32',
  })
  const noon = selectV21IntradayBars(parseFiveMinuteKlines([
    ...validSessionLines('2026-08-11'),
    ...validSessionLines('2026-08-12', '11:30'),
  ]), {
    tradingToday: true,
    phase: '午间休市',
    bjNow: '2026-08-12 12:00',
  })
  const late = selectV21IntradayBars(parseFiveMinuteKlines([
    ...validSessionLines('2026-08-11'),
    ...validSessionLines('2026-08-12', '14:45'),
  ]), {
    tradingToday: true,
    phase: '午盘(盘中)',
    bjNow: '2026-08-12 14:46',
  })

  assert.equal(morning.at(-1).tradeTime, '2026-08-12 10:30:00')
  assert.equal(noon.at(-1).tradeTime, '2026-08-12 11:30:00')
  assert.equal(late.at(-1).tradeTime, '2026-08-12 14:30:00')
  assert.equal(morning.length >= 60, true)
  assert.equal(
    buildV21Request('600519', morning).asOf,
    '2026-08-12 10:30:00',
  )
})

test('V2.1客户端调用独立盘中路由并保留V2.1选择版本', async () => {
  const bars = selectV21IntradayBars(parseFiveMinuteKlines([
    ...validSessionLines('2026-08-11'),
    ...validSessionLines('2026-08-12', '10:30'),
  ]), {
    tradingToday: true,
    phase: '早盘(盘中)',
    bjNow: '2026-08-12 10:32',
  })
  let captured = null
  const result = await fetchV21QuantPredict('600519', {
    bars,
    env: {
      V2_QUANT_URL: 'https://123.cn-hangzhou.pai-eas.aliyuncs.com/api/predict/stock_quant_lab_shadow',
      V2_EAS_TOKEN: 'eas-token',
      V2_API_KEY: 'shadow-key',
    },
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            modelVersion: 'v2.1-intraday',
            asOf: '2026-08-12 10:30:00',
            session: 'morning',
            heads: {
              next30m: {
                horizon: '未来30分钟',
                probabilities: { stopLoss: 0.2, timeout: 0.3, takeProfit: 0.5 },
                predictedClass: 'TAKE_PROFIT',
                outlook: { direction: 'bullish', expectedBarrierReturnPct: 0.105 },
              },
              sessionClose: {
                horizon: '截至今日收盘',
                probabilities: { stopLoss: 0.3, timeout: 0.5, takeProfit: 0.2 },
                predictedClass: 'TIMEOUT',
                outlook: { direction: 'neutral', expectedBarrierReturnPct: 0.01 },
              },
            },
            model: { runId: 'run-v21', architecture: 'transformer-dual-head', sha256: 'a'.repeat(64) },
          }
        },
      }
    },
  })

  assert.equal(captured.url.endsWith('/predict-v2-intraday'), true)
  assert.equal(captured.body.asOf, '2026-08-12 10:30:00')
  assert.equal(captured.body.bars.length >= 60, true)
  assert.equal(result.modelVersion, 'v2.1')
  assert.equal(result.selectedModelVersion, 'v2.1')
  assert.equal(result.runtimeModelVersion, 'v2.1-intraday')
  assert.equal(result.forecast.horizon, '未来30分钟')
  assert.equal(result.v21.heads.next30m.predictedClass, 'TAKE_PROFIT')
})

test('V2.0选择器只调用日终模型，不会盘中偷换V2.1', async () => {
  const bars = parseFiveMinuteKlines([
    ...validSessionLines('2026-08-11'),
    ...validSessionLines('2026-08-12', '10:30'),
  ])
  const base = {
    ok: true,
    modelVersion: 'v2',
    forecast: { direction: '看涨', horizon: '下一交易日', upProb: 60 },
    v2: {},
    reads: [],
  }
  let v21Calls = 0
  let v2Calls = 0
  const result = await fetchSelectedQuantPredict(
    'v2',
    '600519',
    [],
    null,
    1000,
    null,
    {
      fetchBars: async () => bars,
      fetchV21: async () => {
        v21Calls++
        return {
          ...base,
          modelVersion: 'v2.1',
          runtimeModelVersion: 'v2.1-intraday',
          v21: { heads: {} },
        }
      },
      fetchV2: async () => {
        v2Calls++
        return base
      },
      timeContext: {
        tradingToday: true,
        isLive: true,
        phase: '早盘(盘中)',
        bjNow: '2026-08-12 10:32',
      },
    },
  )

  assert.equal(result.modelVersion, 'v2')
  assert.equal(result.selectedModelVersion, 'v2')
  assert.equal(v21Calls, 0)
  assert.equal(v2Calls, 1)
})

test('V2.1显式选择后优先盘中双头，失败才标记回退V2.0', async () => {
  const bars = parseFiveMinuteKlines([
    ...validSessionLines('2026-08-11'),
    ...validSessionLines('2026-08-12', '10:30'),
  ])
  const base = {
    ok: true,
    modelVersion: 'v2',
    forecast: { direction: '看涨', horizon: '下一交易日', upProb: 60 },
    v2: {},
    reads: [],
  }
  let v21Calls = 0
  let v2Calls = 0
  const intraday = await fetchSelectedQuantPredict(
    'v2.1',
    '600519',
    [],
    null,
    1000,
    null,
    {
      fetchBars: async () => bars,
      fetchV21: async () => {
        v21Calls++
        return {
          ok: true,
          modelVersion: 'v2.1',
          runtimeModelVersion: 'v2.1-intraday',
          forecast: { direction: '看涨', horizon: '未来30分钟' },
          v21: { heads: {} },
          reads: [],
        }
      },
      fetchV2: async () => {
        v2Calls++
        return base
      },
      timeContext: {
        tradingToday: true,
        isLive: true,
        phase: '早盘(盘中)',
        bjNow: '2026-08-12 10:32',
      },
    },
  )
  assert.equal(intraday.modelVersion, 'v2.1')
  assert.equal(intraday.selectedModelVersion, 'v2.1')
  assert.equal(v21Calls, 1)
  assert.equal(v2Calls, 0)

  const fallback = await fetchSelectedQuantPredict(
    'v2.1',
    '600519',
    [],
    null,
    1000,
    null,
    {
      fetchBars: async () => bars,
      fetchV21: async () => {
        throw new Error('V2.1 unavailable')
      },
      fetchV2: async () => {
        v2Calls++
        return base
      },
      timeContext: {
        tradingToday: true,
        isLive: true,
        phase: '早盘(盘中)',
        bjNow: '2026-08-12 10:32',
      },
    },
  )
  assert.equal(fallback.modelVersion, 'v2')
  assert.equal(fallback.selectedModelVersion, 'v2.1')
  assert.equal(fallback.runtimeModelVersion, 'v2.0-daily')
  assert.equal(fallback.fallback.from, 'v2.1')
  assert.equal(fallback.fallback.to, 'v2')
  assert.match(fallback.fallback.reason, /unavailable/)
  assert.equal(v2Calls, 1)
})
