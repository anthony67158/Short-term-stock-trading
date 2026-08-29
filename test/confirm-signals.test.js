import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildJudgeFundContext,
  buildJudgeUserPrompt,
  deterministicJudge,
  intradayPrimitives,
  JUDGE_MAX_TOKENS,
  judgePriceContractGate,
  judgeConfirmation,
} from '../api/_confirm.js'

test('分时原语包含VWAP连续性、窗口回撤和反弹幅度', () => {
  const trends = Array.from({ length: 10 }, (_, index) => ({
    time: `10:${String(index).padStart(2, '0')}`,
    price: [10, 10.1, 10.2, 10.3, 10.4, 10.35, 10.3, 10.25, 10.2, 10.15][index],
    volume: index < 5 ? 100 : 180,
    avg: 10.2,
  }))

  const prim = intradayPrimitives(trends, 10)

  assert.equal(prim.aboveVwapCount3, 2)
  assert.equal(prim.drawdownFromHighPct < 0, true)
  assert.equal(prim.bounceFromLowPct > 0, true)
  assert.equal(prim.volSurge, true)
})

test('触价后的确认原语不使用触价前分钟线', () => {
  const trends = Array.from({ length: 10 }, (_, index) => ({
    time: `10:${String(index).padStart(2, '0')}`,
    price: index < 8 ? 9 + index * 0.1 : 10 + (index - 8) * 0.1,
    volume: 100,
    avg: 9.8,
  }))
  const watchingAt = new Date('2026-08-24T02:08:00.000Z').getTime()

  const prim = intradayPrimitives(trends, 10, {
    watchingAt,
    now: new Date('2026-08-24T02:09:30.000Z').getTime(),
  })

  assert.equal(prim.postTouchBars, 2)
  assert.equal(prim.analysisStartTime, '10:08')
  assert.equal(prim.winLow, 10)
  assert.equal(prim.mom5Pct, 1)
})

test('触价后样本不足时不伪造持续创新低信号', () => {
  const trends = Array.from({ length: 10 }, (_, index) => ({
    time: `10:${String(index).padStart(2, '0')}`,
    price: 10 - index * 0.02,
    volume: 100,
    avg: 10,
  }))
  const watchingAt = new Date('2026-08-24T02:08:00.000Z').getTime()
  const prim = intradayPrimitives(trends, 10, {
    watchingAt,
    now: new Date('2026-08-24T02:09:30.000Z').getTime(),
  })
  prim.keyDistancePct = -0.1
  prim.sinceTouchPct = -0.1

  const result = deterministicJudge('stop', prim, null)

  assert.equal(prim.higherLows, null)
  assert.equal(result.hits.includes('分时不断创新低,未见企稳'), false)
})

test('触价后样本不足时不把未知结构判成买点失效', () => {
  const trends = Array.from({ length: 10 }, (_, index) => ({
    time: `10:${String(index).padStart(2, '0')}`,
    price: 10 - index * 0.02,
    volume: 100,
    avg: 10,
  }))
  const watchingAt = new Date('2026-08-24T02:08:00.000Z').getTime()
  const prim = intradayPrimitives(trends, 10, {
    watchingAt,
    now: new Date('2026-08-24T02:09:30.000Z').getTime(),
  })
  prim.keyDistancePct = -1.3

  const result = deterministicJudge('buy', prim, null)

  assert.equal(prim.higherLows, null)
  assert.notEqual(result.decision, 'invalid')
})

test('午休后的确认窗口不拼接上午分钟线', () => {
  const trends = [
    { time: '11:27', price: 10.2, volume: 100, avg: 10.1 },
    { time: '11:28', price: 10.1, volume: 100, avg: 10.1 },
    { time: '11:29', price: 10, volume: 100, avg: 10.1 },
    { time: '11:30', price: 9.9, volume: 100, avg: 10.05 },
    { time: '13:00', price: 10.3, volume: 120, avg: 10.1 },
    { time: '13:01', price: 10.4, volume: 130, avg: 10.12 },
  ]
  const prim = intradayPrimitives(trends, 10, {
    watchingAt: new Date('2026-08-24T03:29:00.000Z').getTime(),
    now: new Date('2026-08-24T05:01:30.000Z').getTime(),
  })

  assert.equal(prim.analysisStartTime, '13:00')
  assert.equal(prim.postTouchBars, 2)
  assert.equal(prim.observedTradingMs, 60 * 1000)
  assert.equal(prim.winLow, 10.3)
})

test('Judge生成一次性终局结论、执行区间、手数与依据', () => {
  const prompt = buildJudgeUserPrompt({
    股票: '贵州茅台(600519)',
    动作类型: 'buy',
  })

  assert.match(prompt, /"decision":"confirm\|wait\|invalid"/)
  assert.match(prompt, /立即买入\|维持观望\|放弃买入/)
  assert.match(prompt, /"priceLow":数字或null/)
  assert.match(prompt, /"quantity":整数手数或0/)
  assert.match(prompt, /"basisType"/)
  assert.match(prompt, /"confidence":0-100/)
  assert.match(prompt, /"reason":"一句话中文理由"/)
  assert.doesNotMatch(prompt, /knowledgeAction|知行合一|可执行性/)
  assert.ok(JUDGE_MAX_TOKENS <= 300)
})

test('快速复核比较本轮服务端资金与原军师资金基准', () => {
  const context = buildJudgeFundContext({
    source: 'realtime',
    mainNetYi: -0.4,
    retailNetYi: 0.7,
    mainTrend5: [0.2, 0.4, 0.5, 0.7, 0.8],
    retailTrend5: [-0.1, -0.2, -0.2, -0.3, -0.4],
  }, {
    source: 'realtime',
    mainNetYi: 1.2,
    retailNetYi: -0.5,
  })

  assert.equal(context.available, true)
  assert.equal(context.current.mainNetYi, -0.4)
  assert.equal(context.current.retailNetYi, 0.7)
  assert.equal(context.change.mainDeltaYi, -1.6)
  assert.equal(context.change.relationChanged, true)
})

test('快速Judge每次触价重新拉取服务端主力与散户资金', async () => {
  const now = Date.parse('2026-08-28T02:05:00.000Z')
  let fundCalls = 0
  let receivedFundContext = null
  const trends = Array.from({ length: 6 }, (_, index) => ({
    time: `10:0${index}`,
    price: 10 + index * 0.02,
    volume: 100 + index * 5,
    avg: 10.03,
  }))
  const result = await judgeConfirmation({
    alert: {
      id: 'fund-review',
      code: '600000',
      note: '买点',
      op: 'lte',
      value: 10.1,
      watchingAt: Date.parse('2026-08-28T02:00:00.000Z'),
      watchingPrice: 10,
    },
    advice: {
      action: '立即买入',
      actionPlan: '10.1元买入1手',
      buyPrice: 10.1,
      fundContext: {
        source: 'realtime',
        mainNetYi: 0.8,
        retailNetYi: -0.3,
      },
    },
    quote: {
      price: 10.1,
      tradeDate: '2026-08-28',
      mainInflow: -50_000_000,
      retailInflow: 60_000_000,
      main5dInflow: 287_000_000,
      retail5dInflow: -417_000_000,
    },
    providers: {
      now: () => now,
      marketTimeContext: () => ({
        phase: '早盘(盘中)',
        bjNow: '2026-08-28 10:05',
      }),
      fetchTrendsTx: async () => ({
        trends,
        preClose: 10,
      }),
      fetchKlineTx: async () => null,
      fetchStockFund: async (code, options) => {
        fundCalls += 1
        assert.equal(code, '600000')
        assert.equal(options.preferRealtime, true)
        return {
          source: 'realtime',
          fetchedAt: now,
          mainNetYi: -0.5,
          retailNetYi: 0.6,
          mainTrend5: [-0.5],
          retailTrend5: [0.6],
          historyDayCount: 1,
          historyComplete: false,
        }
      },
      llmJudge: async ({ fundContext }) => {
        receivedFundContext = fundContext
        return {
          decision: 'wait',
          confidence: 82,
          reason: '主力转流出且散户代理转流入，本次不执行',
          basisType: '实时资金与价格',
          basis: '主力与散户资金关系已反转',
        }
      },
    },
  })

  assert.equal(fundCalls, 1)
  assert.equal(receivedFundContext.current.mainNetYi, -0.5)
  assert.equal(receivedFundContext.current.retailNetYi, 0.6)
  assert.equal(receivedFundContext.current.main5dYi, 2.87)
  assert.equal(receivedFundContext.current.retail5dYi, -4.17)
  assert.equal(
    receivedFundContext.current.fiveDaySource,
    'quote-aggregate',
  )
  assert.equal(receivedFundContext.change.relationChanged, true)
  assert.equal(result.signals.funds.current.source, 'realtime')
  assert.equal(result.decision, 'wait')
})

test('快速Judge资金源失败时明确降级且不沿用旧资金冒充实时', async () => {
  const now = Date.parse('2026-08-28T02:05:00.000Z')
  let receivedFundContext = null
  const trends = Array.from({ length: 6 }, (_, index) => ({
    time: `10:0${index}`,
    price: 10 + index * 0.02,
    volume: 100,
    avg: 10.03,
  }))
  const result = await judgeConfirmation({
    alert: {
      id: 'fund-review-failed',
      code: '600000',
      note: '买点',
      op: 'lte',
      value: 10.1,
      watchingAt: Date.parse('2026-08-28T02:00:00.000Z'),
      watchingPrice: 10,
    },
    advice: {
      action: '立即买入',
      actionPlan: '10.1元买入1手',
      buyPrice: 10.1,
      fundContext: {
        source: 'realtime',
        mainNetYi: 0.8,
        retailNetYi: -0.3,
      },
    },
    quote: { price: 10.1 },
    providers: {
      now: () => now,
      marketTimeContext: () => ({
        phase: '早盘(盘中)',
        bjNow: '2026-08-28 10:05',
      }),
      fetchTrendsTx: async () => ({ trends, preClose: 10 }),
      fetchKlineTx: async () => null,
      fetchStockFund: async () => {
        throw new Error('fund source unavailable')
      },
      llmJudge: async ({ fundContext }) => {
        receivedFundContext = fundContext
        return {
          decision: 'wait',
          confidence: 80,
          reason: '最新资金缺失，本次不执行',
        }
      },
    },
  })

  assert.equal(receivedFundContext.available, false)
  assert.equal(receivedFundContext.current, null)
  assert.equal(receivedFundContext.baseline.mainNetYi, 0.8)
  assert.equal(receivedFundContext.change.status, 'UNAVAILABLE')
  assert.equal(result.signals.funds.current, null)
  assert.equal(result.decision, 'wait')
})

test('Judge拒绝与价格契约不一致的预警价', () => {
  const advice = {
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'entry',
        field: 'buyPrice',
        purpose: 'ENTRY',
        price: 10,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
        basis: 'technical.buyZone.high',
        basisPrice: 10,
        basisDistancePct: 0,
        tolerancePct: 1,
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ALL', conditions: [], allMet: false },
    },
  }

  assert.deepEqual(
    judgePriceContractGate({ note: '买点', op: 'lte', value: 10.01 }, advice),
    {
      allowed: false,
      reason: '预警价与已验证价格契约不一致',
      expectedPrice: 10,
    },
  )
  assert.equal(
    judgePriceContractGate({
      note: '买点',
      op: 'lte',
      value: 10,
    }, advice).allowed,
    true,
  )
})

test('旧军师自动预警缺少价格契约时不得进入Judge', () => {
  assert.deepEqual(
    judgePriceContractGate({
      candCode: '600519',
      note: '买点',
      op: 'lte',
      value: 10,
    }, {}),
    {
      allowed: false,
      reason: '旧建议缺少已验证价格契约，请先复核',
      expectedPrice: null,
    },
  )
  assert.equal(
    judgePriceContractGate({
      id: 'manual-alert',
      note: '手工提醒',
      op: 'gte',
      value: 10,
    }, {}).allowed,
    true,
  )
})

test('双路径观察提醒按各自价位与方向匹配价格契约', () => {
  const advice = {
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'watch_pullback',
        field: 'pullbackWatchPrice',
        purpose: 'REVIEW_ONLY',
        price: 96,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
      }, {
        key: 'watch_breakout',
        field: 'breakoutWatchPrice',
        purpose: 'REVIEW_ONLY',
        price: 105,
        direction: 'GTE',
        status: 'PENDING',
        strict: true,
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ANY', conditions: [], allMet: false },
    },
  }

  assert.equal(judgePriceContractGate({
    reviewOnly: true,
    reviewKey: 'watch_pullback',
    op: 'lte',
    value: 96,
  }, advice).allowed, true)
  assert.equal(judgePriceContractGate({
    reviewOnly: true,
    reviewKey: 'watch_breakout',
    op: 'gte',
    value: 105,
  }, advice).allowed, true)
  assert.equal(judgePriceContractGate({
    reviewOnly: true,
    reviewKey: 'watch_breakout',
    op: 'lte',
    value: 105,
  }, advice).allowed, false)
})

test('持仓止盈预警严格匹配目标价而不是误用减仓价', () => {
  const advice = {
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      validationStatus: 'VERIFIED',
      levels: [
        {
          key: 'reduce',
          field: 'reducePrice',
          purpose: 'EXIT',
          price: 10.8,
          direction: 'GTE',
          strict: true,
        },
        {
          key: 'target',
          field: 'targetPrice',
          purpose: 'OBJECTIVE',
          price: 11.2,
          direction: 'GTE',
          strict: true,
        },
      ],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ALL', conditions: [], allMet: false },
    },
  }

  assert.equal(
    judgePriceContractGate({
      planId: 'holding-1',
      note: '止盈',
      op: 'gte',
      value: 11.2,
    }, advice).allowed,
    true,
  )
})

test('买点下方持续走弱时客观判定为失效', () => {
  const result = deterministicJudge('buy', {
    keyDistancePct: -1.5,
    aboveVwap: false,
    mom5Pct: -0.4,
    higherLows: false,
  }, null)

  assert.equal(result.decision, 'invalid')
})

test('止盈触价后回撤并跌破VWAP达到客观确认门槛', () => {
  const result = deterministicJudge('sell', {
    lowerHighs: true,
    aboveVwap: false,
    mom5Pct: -0.25,
    drawdownFromHighPct: -0.4,
    sinceTouchPct: -0.2,
    volSurge: false,
  }, null)

  assert.equal(result.decision, 'confirm')
  assert.equal(result.score >= 1.5, true)
})

test('最新军师已转为减仓时旧加仓点直接失效', async () => {
  const result = await judgeConfirmation({
    alert: {
      code: '600000',
      actKind: 'add',
      note: '补仓点',
      value: 10,
    },
    advice: {
      action: '减仓',
      actionPlan: '反弹到10.5元减仓1手',
      addPrice: 10,
    },
  })

  assert.equal(result.decision, 'invalid')
  assert.equal(result.actionIntent, 'add')
  assert.equal(result.policy, 'advice-mismatch')
  assert.match(result.reason, /不再支持加仓/)
})

test('服务端实时账本无持仓时Judge直接拒绝加仓且不进入行情分析', async () => {
  const result = await judgeConfirmation({
    alert: {
      code: '600000',
      actKind: 'add',
      note: '补仓点',
      value: 10,
    },
    advice: {
      action: '加仓',
      actionPlan: '回踩10元企稳后加仓1手',
      addPrice: 10,
    },
    position: {
      verified: true,
      liveQty: 0,
      sellableToday: 0,
      holdingIds: new Set(),
    },
  })

  assert.equal(result.decision, 'invalid')
  assert.equal(result.source, 'account')
  assert.equal(result.policy, 'position-missing')
  assert.match(result.reason, /未持有/)
})
