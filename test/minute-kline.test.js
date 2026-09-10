import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchFiveMinuteBars,
  parseFiveMinuteKlines,
  selectCompletedDayEndBars,
} from '../api/_minute_kline.js'

function minuteLines() {
  const rows = []
  for (let index = 0; index < 60; index++) {
    const total = 10 * 60 + index * 5
    const hh = String(Math.floor(total / 60)).padStart(2, '0')
    const mm = String(total % 60).padStart(2, '0')
    rows.push(
      `2026-08-10 ${hh}:${mm},10,10,10.1,9.9,${1000 + index},10000`,
    )
  }
  rows.push('2026-08-10 15:00,10,10,10.1,9.9,1100,11000')
  return rows
}

test('解析真实5分钟OHLCV', () => {
  const bars = parseFiveMinuteKlines(minuteLines())
  assert.equal(bars.length, 61)
  assert.equal(bars.at(-1).tradeTime, '2026-08-10 15:00:00')
})

test('盘中分钟线只截取最近一个完整15点窗口', () => {
  const previous = minuteLines().map((line) =>
    line.replaceAll('2026-08-10', '2026-08-07'),
  )
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

test('机会结果结算可显式读取不复权分钟价', async () => {
  let requestedUrl = ''
  const bars = await fetchFiveMinuteBars('600519', {
    adjustment: 'raw',
    completedWindowOnly: false,
    fetchImpl: async (url) => {
      requestedUrl = url
      return {
        ok: true,
        async json() {
          return { data: { klines: minuteLines() } }
        },
      }
    },
  })

  assert.match(requestedUrl, /[?&]fqt=0(?:&|$)/)
  assert.equal(bars.length, 61)
})

test('东财分钟镜像全部失败后回退腾讯5分钟K线', async () => {
  const calls = []
  const tencentRows = minuteLines().map((line) => {
    const values = line.split(',')
    const time = values[0]
      .replaceAll('-', '')
      .replaceAll(' ', '')
      .replaceAll(':', '')
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
})
