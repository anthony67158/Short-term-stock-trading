import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertStrategyVersion,
  marketPageNumbers,
  normalizePickDecision,
  normalizeStoredPickSnapshot,
  rankMarketCandidates,
  rankStrategyShortlist,
  rerankQuantCandidates,
  stockPickSession,
  stockPickSavedLabel,
} from '../shared/stockRanking.js'
import {
  compileStrategySpec,
  createDefaultStrategySpec,
} from '../shared/strategySpec.js'

const row = (patch = {}) => ({
  code: '600000',
  name: '测试股份',
  price: 10,
  pct: 2,
  speed: 0.5,
  mainInflow: 150_000_000,
  mainRatio: 8,
  turnover: 5,
  volRatio: 1.8,
  amount: 800_000_000,
  ...patch,
})

test('过滤 ST、退市、停牌、低流动性和涨停附近标的', () => {
  const rows = [
    row({ code: '600001' }),
    row({ code: '600002', name: 'ST风险' }),
    row({ code: '600003', name: '退市整理' }),
    row({ code: '600004', price: 0 }),
    row({ code: '600005', amount: 20_000_000 }),
    row({ code: '600006', pct: 9.7 }),
    row({ code: '600007', turnover: 31 }),
  ]

  const result = rankMarketCandidates(rows)

  assert.equal(result.universeCount, 7)
  assert.equal(result.eligibleCount, 1)
  assert.deepEqual(result.list.map((item) => item.code), ['600001'])
})

test('资金量能共振标的排在单纯高涨幅标的之前', () => {
  const result = rankMarketCandidates([
    row({
      code: '600010',
      name: '共振股份',
      pct: 3.2,
      speed: 0.8,
      mainInflow: 320_000_000,
      mainRatio: 12,
      turnover: 7,
      volRatio: 2.2,
      amount: 1_500_000_000,
    }),
    row({
      code: '600011',
      name: '冲高股份',
      pct: 8.3,
      speed: 1.5,
      mainInflow: 20_000_000,
      mainRatio: 0.5,
      turnover: 18,
      volRatio: 4.5,
      amount: 300_000_000,
    }),
  ])

  assert.equal(result.list[0].code, '600010')
  assert.ok(result.list[0].marketScore > result.list[1].marketScore)
  assert.ok(result.list[0].reasons.includes('主力资金'))
})

test('返回数量受 limit 约束且分数稳定在 0 到 100', () => {
  const rows = Array.from({ length: 8 }, (_, index) => row({
    code: `6000${String(index).padStart(2, '0')}`,
    mainRatio: index + 1,
  }))

  const result = rankMarketCandidates(rows, { limit: 3 })

  assert.equal(result.list.length, 3)
  assert.ok(result.list.every((item) =>
    Number.isFinite(item.marketScore) &&
    item.marketScore >= 0 &&
    item.marketScore <= 100
  ))
  assert.equal(result.strategyId, 'market-quant-resonance')
  assert.match(result.specVersion, /^strategy\./)
})

test('市场初排阈值和六因子权重由策略规格决定', () => {
  const strategy = compileStrategySpec(createDefaultStrategySpec({
    universe: { minimumAmount: 900_000_000 },
    marketRanking: {
      factorWeights: {
        fund: 0,
        volume: 0,
        momentum: 1,
        speed: 0,
        liquidity: 0,
        turnover: 0,
      },
    },
  }))
  const result = rankMarketCandidates([
    row({ code: '600001', amount: 800_000_000, pct: 3.5 }),
    row({ code: '600002', amount: 1_000_000_000, pct: 1 }),
    row({ code: '600003', amount: 1_000_000_000, pct: 3.5 }),
  ], { strategySpec: strategy })

  assert.equal(result.eligibleCount, 2)
  assert.deepEqual(result.list.map((item) => item.code), ['600003', '600002'])
  assert.equal(result.specVersion, strategy.specVersion)
})

test('量化复排兼顾市场分与模型把握，不由单一热度决定', () => {
  const result = rerankQuantCandidates([
    {
      code: '600020',
      marketScore: 90,
      quant: { score: 42, upProb: 43, expRet: -1 },
    },
    {
      code: '600021',
      marketScore: 72,
      quant: { score: 76, upProb: 66, expRet: 3.2 },
    },
  ], { limit: 1 })

  assert.equal(result.length, 1)
  assert.equal(result[0].code, '600021')
  assert.ok(result[0].combinedScore >= 0 && result[0].combinedScore <= 100)
})

test('策略短名单只把通过入场条件的标的标记为可执行', () => {
  const result = rankStrategyShortlist([
    {
      code: '600020',
      marketScore: 80,
      pct: 2,
      volRatio: 1.5,
      quant: { score: 70, upProb: 60, expRet: 2 },
    },
    {
      code: '600021',
      marketScore: 80,
      pct: 2,
      volRatio: 1.5,
      quant: { score: 40, upProb: 70, expRet: 3 },
    },
  ], { limit: 12 })

  assert.deepEqual(result.executable.map((item) => item.code), ['600020'])
  assert.deepEqual(result.watchlist.map((item) => item.code), ['600021'])
  assert.equal(result.list[0].strategySignal.passed, true)
  assert.equal(result.list[1].strategySignal.passed, false)
  assert.equal(result.signalPassedCount, 1)
  assert.match(result.specVersion, /^strategy\./)
})

test('量化缺失时只进入观察名单且明确记录缺失证据', () => {
  const result = rankStrategyShortlist([
    {
      code: '600020',
      marketScore: 80,
      pct: 2,
      volRatio: 1.5,
      quant: null,
    },
  ])

  assert.deepEqual(result.executable, [])
  assert.equal(result.watchlist.length, 1)
  assert.equal(result.watchlist[0].strategySignal.passed, false)
  assert.ok(result.watchlist[0].strategySignal.failedRules.some(
    (item) => item.field === 'quant.score'
      && item.reason === 'MISSING_VALUE'
  ))
})

test('未通过策略的股票不能被LLM输出升级为可执行', () => {
  const result = normalizePickDecision({
    noTrade: false,
    picks: [
      { code: '600001', actionability: '可执行' },
      { code: '600002', actionability: '可执行' },
    ],
  }, ['600001', '600002'], [
    { code: '600001', strategySignal: { passed: true } },
    { code: '600002', strategySignal: { passed: false } },
  ])

  assert.equal(result.picks[0].actionability, '可执行')
  assert.equal(result.picks[1].actionability, '等待触发')
})

test('所有LLM候选都未通过策略时自动降级为不出手', () => {
  const result = normalizePickDecision({
    noTrade: false,
    picks: [{ code: '600001', actionability: '可执行' }],
  }, ['600001'], [
    { code: '600001', strategySignal: { passed: false } },
  ])

  assert.equal(result.noTrade, true)
  assert.equal(result.picks[0].actionability, '等待触发')
  assert.match(result.noTradeReason, /策略入场条件/)
})

test('前后端策略版本不一致时终止本轮选股', () => {
  assert.doesNotThrow(() => assertStrategyVersion(
    { strategyId: 'market-quant-resonance', specVersion: 'strategy.same' },
    { strategyId: 'market-quant-resonance', specVersion: 'strategy.same' },
  ))
  assert.throws(
    () => assertStrategyVersion(
      { strategyId: 'market-quant-resonance', specVersion: 'strategy.new' },
      { strategyId: 'market-quant-resonance', specVersion: 'strategy.old' },
    ),
    (error) => error?.code === 'STRATEGY_VERSION_MISMATCH',
  )
})

test('全市场总数会展开为完整分页而不是停在第一页 100 只', () => {
  const pages = marketPageNumbers(5892, 100)

  assert.equal(pages.length, 59)
  assert.equal(pages[0], 1)
  assert.equal(pages.at(-1), 59)
})

test('选股输出会剔除候选池外股票并限制最多三只', () => {
  const result = normalizePickDecision({
    noTrade: false,
    picks: [
      { code: '600001' },
      { code: '999999' },
      { code: '600002' },
      { code: '600003' },
      { code: '600004' },
    ],
  }, ['600001', '600002', '600003', '600004'])

  assert.deepEqual(result.picks.map((item) => item.code), ['600001', '600002', '600003'])
  assert.equal(result.noTrade, false)
})

test('不出手结论保留合法条件候选，无有效标的时仍返回空名单', () => {
  const explicit = normalizePickDecision({
    noTrade: true,
    picks: [{ code: '600001' }],
  }, ['600001'])
  const empty = normalizePickDecision({
    noTrade: false,
    picks: [{ code: '999999' }],
  }, ['600001'])

  assert.deepEqual(explicit.picks.map((item) => item.code), ['600001'])
  assert.equal(explicit.picks[0].actionability, '等待触发')
  assert.equal(explicit.noTrade, true)
  assert.equal(empty.noTrade, true)
  assert.deepEqual(empty.picks, [])
  assert.match(empty.noTradeReason, /候选/)
})

test('LLM给空结果但确定性候选存在时降级为观察名单而非空白', () => {
  const result = normalizePickDecision({
    noTrade: true,
    noTradeReason: '量化证据不足',
    picks: [],
  }, ['600001', '600002'], [
    { code: '600001', name: '甲公司', marketScore: 78, combinedScore: 72, tags: ['资金流入'] },
    { code: '600002', name: '乙公司', marketScore: 70, combinedScore: 68, tags: ['板块领涨'] },
  ])

  assert.equal(result.noTrade, true)
  assert.equal(result.fallback, true)
  assert.deepEqual(result.picks.map((item) => item.code), ['600001', '600002'])
  assert.equal(result.picks.every((item) => item.grade === '观察'), true)
  assert.match(result.picks[0].buyPoint, /回踩企稳|放量突破/)
})

test('AI判断当前不追时仍保留有效短名单作为条件候选', () => {
  const result = normalizePickDecision({
    noTrade: true,
    noTradeReason: '当前位置偏高，等待回踩',
    picks: [{
      code: '600001',
      name: '甲公司',
      grade: '中',
      actionability: '可执行',
      reason: '资金与量能共振',
      buyPoint: '回踩确认后再买',
      buyZone: '9.80~9.95',
      target: '10.80',
      stop: '9.40',
    }],
  }, ['600001'], [{
    code: '600001',
    name: '甲公司',
    price: 10,
    combinedScore: 76,
  }])

  assert.equal(result.noTrade, true)
  assert.equal(result.picks.length, 1)
  assert.equal(result.picks[0].code, '600001')
  assert.equal(result.picks[0].actionability, '等待触发')
})

test('确定性回退候选必须提供买入区、目标、止损和触发条件', () => {
  const result = normalizePickDecision({
    noTrade: true,
    noTradeReason: '量化方向尚未确认',
    picks: [],
  }, ['600001'], [{
    code: '600001',
    name: '甲公司',
    price: 10,
    marketScore: 82,
    combinedScore: 75,
    mainInflowYi: 1.2,
    tags: ['主力资金', '量能放大'],
    quant: {
      score: 58,
      upProb: 51,
      buyPrice: 9.9,
      takeProfit: 10.8,
      stopLoss: 9.5,
    },
  }])

  assert.equal(result.noTrade, true)
  assert.equal(result.fallback, true)
  assert.equal(result.picks[0].actionability, '等待触发')
  assert.match(result.picks[0].buyZone, /9\.85/)
  assert.equal(result.picks[0].target, 10.8)
  assert.equal(result.picks[0].stop, 9.5)
  assert.match(result.picks[0].buyPoint, /企稳|突破/)
})

test('休市时允许生成下一交易日观察池而不是禁用选股', () => {
  const intraday = stockPickSession(Date.parse('2026-08-12T02:00:00Z'))
  const overnight = stockPickSession(Date.parse('2026-08-11T18:00:00Z'))

  assert.equal(intraday.trading, true)
  assert.equal(intraday.mode, 'intraday')
  assert.equal(intraday.canRun, true)
  assert.equal(overnight.trading, false)
  assert.equal(overnight.mode, 'next_open')
  assert.equal(overnight.canRun, true)
})

test('读取已保存的空结果时用当时短名单恢复条件候选', () => {
  const saved = normalizeStoredPickSnapshot({
    at: 1000,
    day: '2026-8-11',
    result: {
      noTrade: true,
      noTradeReason: '当前位置不宜追高',
      picks: [],
    },
    shortlist: [{
      code: '600001',
      name: '甲公司',
      price: 10,
      marketScore: 80,
      combinedScore: 74,
    }],
  })

  assert.equal(saved.result.noTrade, true)
  assert.equal(saved.result.picks.length, 1)
  assert.equal(saved.result.picks[0].code, '600001')
  assert.equal(saved.result.picks[0].actionability, '等待触发')
})

test('没有短名单的旧版空结果自动失效以便重新生成', () => {
  const saved = normalizeStoredPickSnapshot({
    at: 1000,
    day: '2026-8-11',
    result: {
      noTrade: true,
      noTradeReason: '旧版空结果',
      picks: [],
    },
  })

  assert.equal(saved.result, null)
  assert.equal(saved.legacyEmpty, true)
})

test('历史选股快照与当前策略版本不一致时自动失效', () => {
  const saved = normalizeStoredPickSnapshot({
    result: {
      noTrade: false,
      picks: [{ code: '600001', actionability: '可执行' }],
    },
    funnel: {
      strategyId: 'market-quant-resonance',
      specVersion: 'strategy.old',
    },
    shortlist: [{ code: '600001' }],
  }, {
    strategyId: 'market-quant-resonance',
    specVersion: 'strategy.current',
  })

  assert.equal(saved.result, null)
  assert.equal(saved.strategyStale, true)
})

test('休市生成结果标记为开盘观察池而不是盘中或明天', () => {
  const label = stockPickSavedLabel({
    savedDay: '2026-8-12',
    currentDay: '2026-8-12',
    savedSession: 'next_open',
    trading: false,
    timeText: '08/12 03:13',
  })

  assert.equal(label, '开盘观察池 08/12 03:13 生成，供下一交易日开盘参考')
  assert.doesNotMatch(label, /盘中|明天/)
})
