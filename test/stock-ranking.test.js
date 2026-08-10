import test from 'node:test'
import assert from 'node:assert/strict'

import {
  marketPageNumbers,
  normalizePickDecision,
  rankMarketCandidates,
  rerankQuantCandidates,
} from '../shared/stockRanking.js'

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

test('不出手结论强制清空名单，无有效标的时自动转为不出手', () => {
  const explicit = normalizePickDecision({
    noTrade: true,
    picks: [{ code: '600001' }],
  }, ['600001'])
  const empty = normalizePickDecision({
    noTrade: false,
    picks: [{ code: '999999' }],
  }, ['600001'])

  assert.deepEqual(explicit.picks, [])
  assert.equal(empty.noTrade, true)
  assert.match(empty.noTradeReason, /候选/)
})
