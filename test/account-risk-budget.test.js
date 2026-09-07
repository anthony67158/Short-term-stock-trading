import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAccountRiskContext, allocateOpportunityBudget } from '../shared/accountRiskBudget.js'
import { evaluateAccountCircuitBreaker } from '../shared/accountCircuitBreaker.js'
import { readOpportunityRadarSnapshot } from '../api/opportunity_radar.js'

const now = Date.parse('2026-09-08T10:00:00+08:00')
const data = {
  account: { cash: 90000 },
  holding: [{ id: 'h1', code: '600001', qty: 10, buyPrice: 10, sl: 9 }],
}
const quotes = { '600001': { code: '600001', price: 10, industry: '测试行业', tradeDate: '2026-09-08' } }

test('现有持仓止损风险消耗新增风险预算', () => {
  const result = buildAccountRiskContext(data, quotes, now)
  assert.equal(result.complete, true)
  assert.ok(result.breaker.holdingRiskAmount > 1000)
  assert.ok(result.availableRisk < 2000)
  assert.equal(result.exposures[0].sectorCode, '测试行业')
  assert.equal(result.totalAssets, 100000)
})

test('持仓缺失报价、止损或报价跨日不得按零风险放行', () => {
  for (const value of [
    buildAccountRiskContext(data, {}, now),
    buildAccountRiskContext({ ...data, holding: [{ ...data.holding[0], sl: null }] }, quotes, now),
    buildAccountRiskContext(data, { '600001': { ...quotes['600001'], tradeDate: '2026-09-07' } }, now),
  ]) {
    assert.equal(value.complete, false)
    assert.equal(value.availableCash, 0)
    assert.equal(value.breaker.allowRiskIncrease, false)
  }
})

test('部分成交计划只占用未成交部分风险且卖出不释放现金', () => {
  const value = evaluateAccountCircuitBreaker({
    account: { cash: 50000, totalAssets: 100000 },
    executionPlans: [
      { side: 'BUY', status: 'PARTIALLY_RECORDED', riskAmount: 1000, targetLots: 10, remainingLots: 4, reservedCash: 4000 },
      { side: 'SELL', status: 'ARMED', expectedNetProceeds: 20000 },
    ],
  })
  assert.equal(value.pendingOpenRiskAmount, 400)
  assert.equal(value.availableCashAfterReservations, 46000)
  assert.equal(value.pendingSellProceedsRecognized, 0)
})

test('一批候选共享现金和风险预算，不各自占用整份账户', () => {
  const context = buildAccountRiskContext({ account: { cash: 100000 } }, {}, now)
  context.availableCash = 6000
  const portfolio = {
    candidates: ['600001', '600002'].map((code) => ({
      code, positionPct: 5, portfolioState: 'INCLUDED',
      entryPlan: { price: 10 },
      exitPlan: { hardStopPrice: 9, takeProfitPrice: 12 },
    })),
  }
  const result = allocateOpportunityBudget(portfolio, context)
  assert.ok(result.candidates[0].accountBudget.maxLots > 0)
  assert.ok(result.candidates.reduce((sum, row) => sum + row.accountBudget.maxAmount, 0) <= 6000)
  assert.equal(context.availableCash, 6000)
  assert.equal(portfolio.candidates[0].accountBudget, undefined)
})

test('机会雷达聚合使用所鉴权账号的持仓与现金', async () => {
  const result = await readOpportunityRadarSnapshot({
    now, accountData: data,
    readQuotes: async (codes) => {
      assert.deepEqual(codes, ['600001'])
      return Object.values(quotes)
    },
    readSector: async () => ({}),
    readFormula: async () => ({}),
    readTail: async () => null,
    readPreCatalyst: async () => null,
    readBaseline: async () => null,
  })
  assert.equal(result.portfolios.intraday.account.totalAssets, 100000)
  assert.ok(result.portfolios.intraday.account.breaker.holdingRiskAmount > 1000)
})
