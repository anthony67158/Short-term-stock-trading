import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FORMULA_IDS,
  evaluateFormulaSelection,
} from '../shared/formulaSelection.js'

function trendCandles({
  count = 40,
  start = 10,
  step = 0.05,
  lastVolume = 800,
} = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = +(start + index * step).toFixed(2)
    return {
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      open: +(close - 0.08).toFixed(2),
      high: +(close + 0.12).toFixed(2),
      low: +(close - 0.12).toFixed(2),
      close,
      volume: index === count - 1 ? lastVolume : 1000,
      amount: 100_000_000,
    }
  })
}

function flatCandles() {
  return Array.from({ length: 40 }, (_, index) => {
    const close = +(10 + index * 0.002 + (index % 2 ? 0.01 : 0)).toFixed(3)
    return {
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      open: +(close - 0.01).toFixed(3),
      high: +(close + 0.05).toFixed(3),
      low: +(close - 0.05).toFixed(3),
      close,
      volume: index === 39 ? 700 : 1000,
      amount: 80_000_000,
    }
  })
}

function intradayInput(overrides = {}) {
  const candles = trendCandles()
  return {
    mode: 'intraday',
    candles,
    quote: {
      code: '600001',
      name: '测试股票',
      price: 12,
      open: 11.8,
      high: 12.1,
      low: 11.75,
      pct: 2.5,
      amount: 200_000_000,
      turnover: 5,
      volumeRatio: 1.5,
    },
    trends: [11.92, 11.95, 11.97, 12, 12.01].map((price) => ({
      price,
      avg: 11.9,
      volume: 100,
    })),
    fund: {
      mainNetYi: 0.2,
      retailNetYi: -0.1,
      main5dYi: 0.5,
      historyDayCount: 5,
    },
    sectorOpportunity: {
      matched: true,
      sector: { name: '测试主线' },
    },
    ...overrides,
  }
}

test('盘中扫描识别回踩承接和资金先行公式', () => {
  const result = evaluateFormulaSelection(intradayInput())
  const ids = result.matches.map((item) => item.formulaId)

  assert.ok(ids.includes(FORMULA_IDS.INTRADAY_VWAP_PULLBACK))
  assert.ok(ids.includes(FORMULA_IDS.INTRADAY_ACCUMULATION))
  assert.ok(result.matches.every((item) => item.validationState === 'OBSERVE_ONLY'))
  assert.ok(result.matches.every((item) => item.anchors.primary > 0))
})

test('盘中公式在板块未确认或主力流出小单流入时全部否决', () => {
  const noSector = evaluateFormulaSelection(intradayInput({
    sectorOpportunity: { matched: false },
  }))
  assert.equal(noSector.matches.length, 0)

  const distribution = evaluateFormulaSelection(intradayInput({
    fund: {
      mainNetYi: -0.2,
      retailNetYi: 0.2,
      main5dYi: -0.4,
      historyDayCount: 5,
    },
  }))
  assert.equal(distribution.matches.length, 0)
  assert.match(
    distribution.evaluations[0].blockers.join('；'),
    /主力净流出0\.20亿元、小单净流入0\.20亿元/,
  )
})

test('公式阻断文案同时给出当前值和通过门槛', () => {
  const result = evaluateFormulaSelection(intradayInput({
    quote: {
      ...intradayInput().quote,
      pct: 6.2,
      amount: 42_000_000,
      turnover: 1.3,
      volumeRatio: 0.8,
    },
  }))
  const blockers = result.evaluations.flatMap((item) => item.blockers)
    .join('；')

  assert.match(blockers, /当前成交额0\.42亿元/)
  assert.match(blockers, /要求至少0\.50亿元/)
  assert.match(blockers, /当前换手率1\.3%/)
  assert.match(blockers, /要求至少2%/)
  assert.match(blockers, /当日已上涨6\.2%/)
  assert.match(blockers, /超过5%追高线/)
})

test('收盘扫描识别趋势回踩并输出次日支撑锚点', () => {
  const result = evaluateFormulaSelection({
    ...intradayInput(),
    mode: 'close',
    trends: [],
  })
  const match = result.matches.find(
    (item) => item.formulaId === FORMULA_IDS.CLOSE_TREND_PULLBACK,
  )

  assert.ok(match)
  assert.equal(match.priceType, 'PULLBACK_WATCH')
  assert.ok(match.anchors.primary < 12)
})

test('收盘扫描识别布林收窄并输出唯一突破观察价', () => {
  const candles = flatCandles()
  const result = evaluateFormulaSelection({
    ...intradayInput(),
    mode: 'close',
    candles,
    quote: {
      ...intradayInput().quote,
      price: candles.at(-1).close,
      open: candles.at(-1).open,
      high: candles.at(-1).high,
      low: candles.at(-1).low,
      pct: 1,
      amount: 80_000_000,
      turnover: 3,
    },
  })
  const match = result.matches.find(
    (item) => item.formulaId === FORMULA_IDS.CLOSE_SQUEEZE,
  )

  assert.ok(match)
  assert.equal(match.priceType, 'BREAKOUT_WATCH')
  assert.ok(match.anchors.primary > candles.at(-1).close)
})
