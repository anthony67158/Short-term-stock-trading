import test from 'node:test'
import assert from 'node:assert/strict'

import {
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

test('Judge只生成交易时机结论，不再重复生成知行合一评分', () => {
  const prompt = buildJudgeUserPrompt({ 股票: '贵州茅台(600519)' })

  assert.match(prompt, /"decision":"confirm\|wait\|invalid"/)
  assert.match(prompt, /"confidence":0-100/)
  assert.match(prompt, /"reason":"一句话中文理由"/)
  assert.doesNotMatch(prompt, /knowledgeAction|知行合一|可执行性/)
  assert.ok(JUDGE_MAX_TOKENS <= 160)
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
