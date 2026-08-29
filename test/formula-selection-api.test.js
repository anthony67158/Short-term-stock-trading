import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockFormulaSelection,
  passesFormulaRealtimePrefilter,
  scanFormulaSelectionCandidates,
} from '../api/_formula_selection_data.js'
import {
  runFormulaSelection,
} from '../api/formula_selection.js'
import {
  formulaSelectionTimerBody,
} from '../api/_advice_timer.js'

function candles() {
  return Array.from({ length: 40 }, (_, index) => {
    const close = +(10 + index * 0.05).toFixed(2)
    return {
      date: `2026-07-${String(index + 1).padStart(2, '0')}`,
      open: +(close - 0.08).toFixed(2),
      high: +(close + 0.12).toFixed(2),
      low: +(close - 0.12).toFixed(2),
      close,
      volume: index === 39 ? 800 : 1000,
      amount: 100_000_000,
    }
  })
}

function quote(overrides = {}) {
  return {
    code: '600001',
    name: '测试股票',
    price: 12,
    open: 11.8,
    high: 12.1,
    low: 11.75,
    pct: 2.5,
    volume: 800,
    amount: 200_000_000,
    turnover: 5,
    volumeRatio: 1.5,
    tradeDate: '2026-08-28',
    ...overrides,
  }
}

const fund = {
  mainNetYi: 0.2,
  retailNetYi: -0.1,
  main5dYi: 0.5,
  historyDayCount: 5,
}

test('盘中和收盘预筛使用不同边界且排除风险名称', () => {
  assert.equal(
    passesFormulaRealtimePrefilter(quote(), 'intraday', '2026-08-28'),
    true,
  )
  assert.equal(
    passesFormulaRealtimePrefilter(
      quote({ pct: -2, turnover: 1.5 }),
      'close',
      '2026-08-28',
    ),
    true,
  )
  assert.equal(
    passesFormulaRealtimePrefilter(
      quote({ name: 'ST测试' }),
      'intraday',
      '2026-08-28',
    ),
    false,
  )
})

test('市场扫描从完整股票池生成最多五个带唯一价位的观察候选', async () => {
  const result = await scanFormulaSelectionCandidates({
    mode: 'intraday',
    now: Date.UTC(2026, 7, 28, 7),
    marketContext: {
      marketGate: { allowed: true },
      latest: null,
      intraday: null,
    },
    fetchUniverse: async () => ({
      total: 5500,
      inspectedCount: 5500,
      allList: [quote()],
    }),
    fetchKline: async () => {
      const rows = candles()
      rows.at(-1).high = 12.6
      return { candles: rows }
    },
    fetchTrends: async () => ({
      trends: [11.92, 11.95, 11.97, 12, 12.01].map((price) => ({
        price,
        avg: 11.9,
        volume: 100,
      })),
    }),
    fetchFund: async () => fund,
    fetchTags: async () => ({ industry: '测试', concepts: [] }),
    matchSector: () => ({
      matched: true,
      sector: { code: 'BK001', name: '测试主线' },
    }),
  })

  assert.equal(result.universe.inspectedCount, 5500)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].action, 'WATCH_BUY')
  assert.equal(result.candidates[0].validationState, 'OBSERVE_ONLY')
  assert.ok(result.candidates[0].primaryPrice > 0)
})

test('个股价位读取服务端持仓并返回军师只读参考', async () => {
  const result = await buildStockFormulaSelection({
    code: '600001',
    account: {
      holding: [{ code: '600001', qty: 2, buyPrice: 10 }],
      closed: [],
    },
    now: Date.UTC(2026, 7, 28, 7),
    fetchQuote: async () => quote({ price: 9.4 }),
    fetchKline: async () => ({ candles: candles() }),
    fetchTrends: async () => ({ trends: [] }),
    fetchFund: async () => fund,
    collectMarketContext: async () => ({
      marketGate: { allowed: true },
      latest: null,
      intraday: null,
    }),
    fetchTags: async () => ({ industry: '测试', concepts: [] }),
    matchSector: () => ({ matched: true }),
    computeTech: () => ({
      atr: { atr: 0.4 },
      sr: { support: 9.6, resistance: 11 },
      ma: { ma10: 9.8 },
      pricePlan: { stopLoss: 9.5 },
    }),
  })

  assert.equal(result.decision.positionMode, 'HELD')
  assert.equal(result.decision.action, 'EXIT')
  assert.equal(result.advisorReference.role, 'DETERMINISTIC_RISK_OVERRIDE')
  assert.equal(result.advisorReference.canForceRiskReduction, true)
})

test('资金或市场源失败时仍保留持仓硬止损', async () => {
  const result = await buildStockFormulaSelection({
    code: '600001',
    account: {
      holding: [{ code: '600001', qty: 2, buyPrice: 10 }],
      closed: [],
    },
    now: Date.UTC(2026, 7, 28, 7),
    fetchQuote: async () => quote({ price: 9.4 }),
    fetchKline: async () => ({ candles: candles() }),
    fetchTrends: async () => ({ trends: [] }),
    fetchFund: async () => { throw new Error('fund unavailable') },
    fetchTags: async () => { throw new Error('tags unavailable') },
    collectMarketContext: async () => {
      throw new Error('market unavailable')
    },
    matchSector: () => ({ matched: false }),
    computeTech: () => ({
      atr: { atr: 0.4 },
      sr: { support: 9.6, resistance: 11 },
      ma: { ma10: 9.8 },
      pricePlan: { stopLoss: 9.5 },
    }),
  })

  assert.equal(result.decision.action, 'EXIT')
  assert.equal(result.decision.primaryPrice, 9.5)
})

test('收盘定时器只接受专用触发器和正确密钥', () => {
  assert.deepEqual(
    formulaSelectionTimerBody({
      triggerName: 'formula-selection-close-timer',
      payload: 'secret',
    }, 'secret'),
    { scheduled: true, mode: 'close' },
  )
  assert.equal(
    formulaSelectionTimerBody({
      triggerName: 'tail-pick-1450-timer',
      payload: 'secret',
    }, 'secret'),
    null,
  )
})

test('公式选股任务保存同一模式结果并保持幂等', async () => {
  let saved = null
  const store = {
    readLatest: async () => saved,
    saveRun: async (_mode, value) => { saved = value },
    claimRun: async () => ({ acquired: true, owner: 'owner' }),
    releaseRun: async () => true,
  }
  const scan = async () => ({
    universe: { inspectedCount: 5500 },
    formulas: [],
    candidates: [],
  })

  const first = await runFormulaSelection({
    mode: 'close',
    store,
    scan,
    collectMarketContext: async () => ({
      marketGate: { allowed: true },
    }),
    now: () => Date.UTC(2026, 7, 28, 7, 5),
  })
  const second = await runFormulaSelection({
    mode: 'close',
    store,
    scan,
    collectMarketContext: async () => ({
      marketGate: { allowed: true },
    }),
    now: () => Date.UTC(2026, 7, 28, 7, 5),
  })

  assert.equal(first.schemaVersion, 'formula-selection.v1')
  assert.equal(first.mode, 'CLOSE')
  assert.equal(second.reused, true)
})
