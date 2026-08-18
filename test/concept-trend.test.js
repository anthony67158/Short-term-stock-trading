import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildConceptTrendSummary,
  filterConceptSectors,
  formatConceptKlineTooltip,
  formatConceptTrendTooltip,
  parseConceptKlinePayload,
  parseConceptCloseHistoryPayload,
  parseConceptTrendPayload,
  selectLongestConceptKlinePayload,
} from '../shared/conceptTrend.js'

const payload = {
  data: {
    code: 'BK1128',
    name: 'CPO概念',
    preClose: 100,
    trends: [
      '2026-08-14 09:30,101,101,102,100.5,1200,3000000,100.8',
      '2026-08-14 09:31,101,102,102.5,100.8,800,2200000,101.2',
      '2026-08-14 15:00,103,104,104.2,102.9,1500,5200000,102.7',
    ],
  },
}

test('概念分时按东方财富字段保留价格均价成交量与真实交易日期', () => {
  const result = parseConceptTrendPayload(payload, 'BK1128')

  assert.equal(result.code, 'BK1128')
  assert.equal(result.name, 'CPO概念')
  assert.equal(result.preClose, 100)
  assert.equal(result.tradingDate, '2026-08-14')
  assert.deepEqual(result.points, [
    {
      at: '2026-08-14 09:30',
      time: '09:30',
      price: 101,
      avg: 100.8,
      pct: 1,
      avgPct: 0.8,
      volume: 1200,
      amount: 3000000,
    },
    {
      at: '2026-08-14 09:31',
      time: '09:31',
      price: 102,
      avg: 101.2,
      pct: 2,
      avgPct: 1.2,
      volume: 800,
      amount: 2200000,
    },
    {
      at: '2026-08-14 15:00',
      time: '15:00',
      price: 104,
      avg: 102.7,
      pct: 4,
      avgPct: 2.7,
      volume: 1500,
      amount: 5200000,
    },
  ])
})

test('概念分时摘要使用分钟序列计算最新涨跌振幅与成交额', () => {
  const parsed = parseConceptTrendPayload(payload)
  assert.deepEqual(
    buildConceptTrendSummary(parsed.points, parsed.preClose),
    {
      latest: 104,
      pct: 4,
      high: 104,
      low: 101,
      amplitude: 3,
      volume: 3500,
      amount: 10400000,
      lastTime: '15:00',
    },
  )
})

test('概念分时拒绝无效点且 tooltip 不输出对象占位文本', () => {
  const parsed = parseConceptTrendPayload({
    data: {
      code: 'BK1128',
      name: 'CPO概念',
      preClose: 100,
      trends: ['bad', '2026-08-14 09:30,-,-,-,-,-,-,-'],
    },
  })
  assert.deepEqual(parsed.points, [])

  const text = formatConceptTrendTooltip([{
    axisValue: '09:31',
    data: {
      value: 2,
      price: 102,
      avg: 101.2,
      volume: 800,
      amount: 2200000,
    },
  }])
  assert.match(text, /涨跌: \+2\.00%/)
  assert.match(text, /指数: 102/)
  assert.match(text, /成交额: 220\.00万/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

test('概念目录不截断完整数据且支持名称和代码搜索', () => {
  const sectors = Array.from({ length: 504 }, (_, index) => ({
    code: `BK${String(index).padStart(4, '0')}`,
    name: index === 503 ? '创新药' : `概念${index}`,
  }))

  assert.equal(filterConceptSectors(sectors, '').length, 504)
  assert.deepEqual(filterConceptSectors(sectors, '创新'), [sectors[503]])
  assert.deepEqual(filterConceptSectors(sectors, 'BK0503'), [sectors[503]])
})

test('概念历史K线按东方财富字段解析为OCLH和成交量数据', () => {
  const parsed = parseConceptKlinePayload({
    data: {
      code: 'BK1128',
      name: 'CPO概念',
      klines: [
        '2026-08-13,100,103,104,99,1200,3000000,5.00,3.00,3.00,1.20',
        '2026-08-14,103,102,105,101,1600,4200000,3.88,-0.97,-1.00,1.45',
      ],
    },
  }, 'BK1128', 'day')

  assert.equal(parsed.code, 'BK1128')
  assert.equal(parsed.name, 'CPO概念')
  assert.equal(parsed.period, 'day')
  assert.deepEqual(parsed.points, [
    {
      date: '2026-08-13',
      open: 100,
      close: 103,
      high: 104,
      low: 99,
      volume: 1200,
      amount: 3000000,
      amplitude: 5,
      pct: 3,
      change: 3,
      turnover: 1.2,
    },
    {
      date: '2026-08-14',
      open: 103,
      close: 102,
      high: 105,
      low: 101,
      volume: 1600,
      amount: 4200000,
      amplitude: 3.88,
      pct: -0.97,
      change: -1,
      turnover: 1.45,
    },
  ])
  assert.deepEqual(parsed.summary, {
    latest: 102,
    pct: -0.97,
    high: 105,
    low: 101,
    amplitude: 3.88,
    volume: 1600,
    amount: 4200000,
    lastDate: '2026-08-14',
  })
})

test('多镜像历史K线优先选择非空且序列最长的响应', () => {
  const empty = { data: { code: 'BK1128', klines: [] } }
  const short = { data: { code: 'BK1128', klines: ['a'] } }
  const full = { data: { code: 'BK1128', klines: ['a', 'b', 'c'] } }

  assert.equal(
    selectLongestConceptKlinePayload([empty, full, short]),
    full,
  )
})

test('概念K线tooltip明确开高低收且不输出对象占位文本', () => {
  const text = formatConceptKlineTooltip([{
    axisValue: '2026-08-14',
    data: {
      value: [103, 102, 101, 105],
      open: 103,
      close: 102,
      high: 105,
      low: 101,
      pct: -0.97,
      volume: 1600,
      amount: 4200000,
    },
  }])

  assert.match(text, /开: 103/)
  assert.match(text, /高: 105/)
  assert.match(text, /低: 101/)
  assert.match(text, /收: 102/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

test('K线源为空时可从历史资金数据构建真实收盘趋势', () => {
  const payload = {
    data: {
      code: 'BK1106',
      name: '创新药',
      klines: [
        '2026-08-10,100000000,0,0,0,0,2.1,0,0,0,0,1500,1.2',
        '2026-08-11,-20000000,0,0,0,0,-0.5,0,0,0,0,1490,-0.67',
        '2026-08-14,50000000,0,0,0,0,1.1,0,0,0,0,1538.39,3.25',
      ],
    },
  }
  const parsed = parseConceptCloseHistoryPayload(
    payload,
    'BK1106',
    'day',
  )

  assert.equal(parsed.format, 'close-line')
  assert.deepEqual(parsed.points, [
    {
      date: '2026-08-10',
      close: 1500,
      pct: 1.2,
      mainInflow: 100000000,
      mainRatio: 2.1,
    },
    {
      date: '2026-08-11',
      close: 1490,
      pct: -0.67,
      mainInflow: -20000000,
      mainRatio: -0.5,
    },
    {
      date: '2026-08-14',
      close: 1538.39,
      pct: 3.25,
      mainInflow: 50000000,
      mainRatio: 1.1,
    },
  ])
  assert.equal(parsed.summary.latest, 1538.39)
  assert.equal(parsed.summary.lastDate, '2026-08-14')
  assert.equal(parsed.summary.sampleCount, 3)
})

test('历史收盘趋势可按自然周与自然月聚合', () => {
  const rows = [
    '2026-07-31,10,0,0,0,0,1,0,0,0,0,100,1',
    '2026-08-03,20,0,0,0,0,2,0,0,0,0,102,2',
    '2026-08-07,30,0,0,0,0,3,0,0,0,0,105,2.94',
    '2026-08-10,-5,0,0,0,0,-1,0,0,0,0,103,-1.9',
  ]
  const week = parseConceptCloseHistoryPayload(
    { data: { klines: rows } },
    'BK1106',
    'week',
  )
  const month = parseConceptCloseHistoryPayload(
    { data: { klines: rows } },
    'BK1106',
    'month',
  )

  assert.deepEqual(week.points.map((point) => point.date), [
    '2026-07-31',
    '2026-08-07',
    '2026-08-10',
  ])
  assert.deepEqual(month.points.map((point) => point.date), [
    '2026-07-31',
    '2026-08-10',
  ])
  assert.equal(week.points[1].mainInflow, 50)
  assert.equal(month.points[1].mainInflow, 45)
})
