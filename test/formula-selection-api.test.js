import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertCompleteFormulaUniverse,
  buildStockFormulaSelection,
  passesFormulaRealtimePrefilter,
  scanFormulaSelectionCandidates,
} from '../api/_formula_selection_data.js'
import {
  formulaSelectionPublicError,
  runFormulaSelection,
} from '../api/formula_selection.js'
import {
  createFormulaSelectionStore,
} from '../api/_formula_selection_store.js'
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

test('公式价位不会向界面泄露上游HTTP 501', () => {
  assert.deepEqual(
    formulaSelectionPublicError(new Error('HTTP 501')),
    {
      error: '行情数据暂时不可用，请稍后重试',
      errorCode: 'MARKET_DATA_UNAVAILABLE',
    },
  )
})

test('市场扫描从完整股票池生成最多五个带唯一价位的观察候选', async () => {
  const progress = []
  const allList = Array.from({ length: 5500 }, (_, index) => (
    index === 0
      ? quote()
      : quote({
          code: String(100000 + index),
          amount: 0,
        })
  ))
  const result = await scanFormulaSelectionCandidates({
    mode: 'intraday',
    now: Date.UTC(2026, 7, 28, 7),
    onProgress: async (next) => { progress.push(next) },
    marketContext: {
      marketGate: { allowed: true },
      latest: null,
      intraday: null,
    },
    fetchUniverse: async () => ({
      total: 5500,
      inspectedCount: 5500,
      allList,
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
  assert.equal(result.candidateEvents.length, 1)
  assert.equal(result.candidateEvents[0].stageReached, 'DISPLAYED')
  assert.equal(
    result.candidateEvents[0].decision.priceContractValid,
    true,
  )
  assert.deepEqual(
    [...new Set(progress.map((item) => item.stage))],
    ['UNIVERSE', 'PREFILTER', 'TECHNICAL', 'EVIDENCE', 'RANKING'],
  )
  assert.equal(progress.at(-1).percent, 97)

  const blocked = await scanFormulaSelectionCandidates({
    mode: 'intraday',
    now: Date.UTC(2026, 7, 28, 7),
    marketContext: {
      marketGate: {
        allowed: false,
        blockers: ['市场风险偏高'],
      },
      latest: null,
      intraday: null,
    },
    fetchUniverse: async () => ({
      total: 5500,
      inspectedCount: 5500,
      allList,
    }),
    fetchKline: async () => {
      const rows = candles()
      rows.at(-1).high = 12.6
      return { candles: rows }
    },
    fetchTrends: async () => ({
      trends: [11.92, 11.95, 11.97, 12, 12.01].map((current) => ({
        price: current,
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
  assert.equal(blocked.universe.inspectedCount, 5500)
  assert.equal(blocked.candidates.length, 1)
  assert.equal(blocked.candidates[0].action, 'AVOID')
  assert.ok(blocked.candidates[0].primaryPrice > 0)
  assert.ok(blocked.candidates[0].stopPrice > 0)
  assert.ok(blocked.candidates[0].targetPrice > 0)
  assert.match(blocked.candidates[0].blockers.join('；'), /市场风险偏高/)
})

test('公式扫描不会因实时排序只检查前60只而漏掉后续命中', async () => {
  const quotes = Array.from({ length: 61 }, (_, index) => quote({
    code: String(600001 + index),
    amount: 300_000_000 - index,
  }))
  const result = await scanFormulaSelectionCandidates({
    mode: 'intraday',
    now: Date.UTC(2026, 7, 28, 7),
    marketContext: {
      marketGate: { allowed: true },
      latest: null,
      intraday: null,
    },
    fetchUniverse: async () => ({
      total: quotes.length,
      inspectedCount: quotes.length,
      allList: quotes,
    }),
    fetchKline: async (code) => {
      if (code !== '600061') return null
      const rows = candles()
      rows.at(-1).high = 12.6
      return { candles: rows }
    },
    fetchTrends: async () => ({
      trends: [11.92, 11.95, 11.97, 12, 12.01].map((value) => ({
        price: value,
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

  assert.equal(result.candidates[0].code, '600061')
  assert.equal(result.candidateEvents.length, 61)
  assert.equal(
    result.candidateEvents.filter(
      (item) => item.stageReached === 'DISPLAYED',
    ).length,
    1,
  )
  assert.equal(
    result.candidateEvents.filter(
      (item) => item.stageReached === 'PREFILTER',
    ).length,
    60,
  )
})

test('公式扫描拒绝用不完整股票列表冒充全市场', async () => {
  assert.throws(
    () => assertCompleteFormulaUniverse({
      total: 5500,
      inspectedCount: 60,
      allList: Array.from({ length: 60 }, (_, index) => quote({
        code: String(600001 + index),
      })),
    }),
    /全市场快照不完整：60\/5500/,
  )
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

test('旧K线快照只用于展示且不能生成可执行公式价位', async () => {
  const fetchedAt = Date.UTC(2026, 7, 27, 7)
  const result = await buildStockFormulaSelection({
    code: '600001',
    account: { holding: [], closed: [] },
    now: Date.UTC(2026, 7, 28, 7),
    fetchQuote: async () => quote({ price: 10 }),
    fetchKline: async () => ({
      candles: candles(),
      stale: true,
      fetchedAt,
    }),
    fetchTrends: async () => ({ trends: [] }),
    fetchFund: async () => fund,
    collectMarketContext: async () => ({
      marketGate: { allowed: true },
      latest: null,
      intraday: null,
    }),
    fetchTags: async () => ({ industry: '测试', concepts: [] }),
    matchSector: () => ({ matched: true }),
  })

  assert.equal(result.stale, true)
  assert.equal(result.dataAsOf, fetchedAt)
  assert.equal(result.decision.dataFresh, false)
  assert.equal(result.decision.action, 'AVOID')
  assert.equal(result.advisorReference.effectiveWeight, 0)
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
  let ledgerBatch = null
  const progress = []
  const store = {
    readLatest: async () => saved,
    saveRun: async (_mode, value) => { saved = value },
    saveProgress: async (_mode, value) => { progress.push(value) },
    claimRun: async () => ({ acquired: true, owner: 'owner' }),
    releaseRun: async () => true,
  }
  const scan = async ({ onProgress }) => {
    await onProgress({
      stage: 'TECHNICAL',
      percent: 60,
      message: '正在检查日线形态',
    })
    return {
      universe: { inspectedCount: 5500 },
      formulas: [],
      candidates: [],
      candidateEvents: [{
        code: '600001',
        name: '测试股份',
        stageReached: 'TECHNICAL',
        rejectionReasons: ['收盘未站上MA20'],
      }],
    }
  }

  const first = await runFormulaSelection({
    mode: 'close',
    store,
    ledgerStore: {
      saveBatch: async (value) => { ledgerBatch = value },
    },
    scan,
    collectMarketContext: async () => ({
      marketGate: { allowed: true },
    }),
    now: () => Date.UTC(2026, 7, 28, 7, 5),
  })
  const second = await runFormulaSelection({
    mode: 'close',
    store,
    ledgerStore: {
      saveBatch: async (value) => { ledgerBatch = value },
    },
    scan,
    collectMarketContext: async () => ({
      marketGate: { allowed: true },
    }),
    now: () => Date.UTC(2026, 7, 28, 7, 5),
  })

  assert.equal(first.schemaVersion, 'formula-selection.v1')
  assert.equal(first.mode, 'CLOSE')
  assert.equal(first.ledger.runId, '2026-08-28:close:1505')
  assert.equal(first.ledger.summary.total, 1)
  assert.equal(ledgerBatch.events[0].stageReached, 'TECHNICAL')
  assert.equal('candidateEvents' in first, false)
  assert.equal(second.reused, true)
  assert.deepEqual(
    progress.map((item) => item.stage),
    ['MARKET_GATE', 'TECHNICAL', 'SAVING', 'DONE'],
  )
  assert.equal(progress.at(-1).percent, 100)
})

test('公式结果附加影子评分但不改变现有候选顺序', async () => {
  let savedLedger = null
  let scoreInputs = null
  const candidates = ['600002', '600001'].map((code, index) => ({
    code,
    name: `测试${index}`,
    score: 90 - index,
    formulaId: 'CLOSE_TREND_PULLBACK',
    action: 'WATCH_BUY',
    primaryPrice: 10,
    priceType: 'PULLBACK_WATCH',
    stopPrice: 9.5,
    targetPrice: 11,
    riskReward: 2,
    priceContractValid: true,
    quote: quote({ code }),
    blockers: [],
  }))
  const candidateEvents = candidates.map((candidate, index) => ({
    code: candidate.code,
    name: candidate.name,
    stageReached: 'DISPLAYED',
    displayedRank: index + 1,
    cheapScore: 40 - index,
    quote: candidate.quote,
    formulaEvaluations: [{
      formulaId: candidate.formulaId,
      matched: true,
      score: candidate.score,
    }],
    decision: candidate,
    sector: {
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
    },
  }))
  const result = await runFormulaSelection({
    mode: 'close',
    store: {
      readLatest: async () => null,
      saveRun: async () => {},
      saveProgress: async () => {},
      claimRun: async () => ({ acquired: true }),
      releaseRun: async () => true,
    },
    ledgerStore: {
      saveBatch: async (value) => { savedLedger = value },
    },
    scan: async () => ({
      universe: {
        total: 2,
        inspectedCount: 2,
        tradeDate: '2026-08-28',
      },
      formulas: [],
      candidates,
      candidateEvents,
    }),
    scoreOpportunities: async (inputs) => {
      scoreInputs = inputs
      return new Map(inputs.map((input, index) => [
        input.code,
        {
          schemaVersion: 'opportunity-score.v1',
          state: 'READY',
          code: input.code,
          formulaId: input.formulaId,
          pFill: 0.6 + index * 0.2,
          pWinGivenFill: 0.55,
          expectedNetR: 0.1 + index,
          netRLowerBound: -0.1,
          expectedShortfall10: -1,
        },
      ]))
    },
    collectMarketContext: async () => ({
      marketGate: {
        allowed: true,
        riskTier: 'STANDARD',
      },
    }),
    now: () => Date.UTC(2026, 7, 28, 7, 5),
  })

  assert.equal(scoreInputs.length, 2)
  assert.deepEqual(
    result.candidates.map((item) => item.code),
    ['600002', '600001'],
  )
  assert.equal(result.candidates[0].opportunityScore.pFill, 0.6)
  assert.equal(result.candidates[1].opportunityScore.pFill, 0.8)
  assert.equal(
    savedLedger.events[0].opportunityScore.state,
    'READY',
  )
  assert.equal(
    savedLedger.events[0].scoreInput.schemaVersion,
    'opportunity-score-feature.v1',
  )
  assert.deepEqual(result.shadowRanking, {
    requested: 2,
    ready: 2,
    unavailable: 0,
    appliedToOrder: false,
  })
})

test('公式选股进度按模式独立持久化并可恢复读取', async () => {
  const store = createFormulaSelectionStore({
    hasStorage: () => false,
  })
  const task = {
    id: 'formula-close-1505',
    mode: 'close',
    status: 'RUNNING',
    stage: 'TECHNICAL',
    percent: 56,
    message: '正在检查日线形态',
  }

  await store.saveProgress('close', task)

  assert.deepEqual(await store.readProgress('close'), task)
  assert.equal(await store.readProgress('intraday'), null)
})

test('市场闸门不允许新增风险时仍完成全市场个股计算', async () => {
  let scanCalls = 0
  let saved = null
  const store = {
    readLatest: async () => null,
    saveRun: async (_mode, value) => { saved = value },
    claimRun: async () => ({ acquired: true, owner: 'owner' }),
    releaseRun: async () => true,
  }
  const result = await runFormulaSelection({
    mode: 'intraday',
    store,
    scan: async () => {
      scanCalls += 1
      return {
        universe: {
          total: 5500,
          inspectedCount: 5500,
        },
        formulas: [],
        candidates: [{
          code: '600001',
          name: '测试股份',
          action: 'AVOID',
          primaryPrice: 10,
          stopPrice: 9.6,
          targetPrice: 10.8,
          blockers: ['市场风险偏高'],
        }],
      }
    },
    collectMarketContext: async () => ({
      marketGate: {
        allowed: false,
        blockers: ['市场风险偏高'],
      },
    }),
    now: () => Date.UTC(2026, 7, 28, 2),
  })

  assert.equal(scanCalls, 1)
  assert.equal(result.universe.inspectedCount, 5500)
  assert.equal(result.candidates[0].primaryPrice, 10)
  assert.equal(result.candidates[0].action, 'AVOID')
  assert.match(result.reason, /市场风险偏高/)
  assert.deepEqual(saved, result)
})
