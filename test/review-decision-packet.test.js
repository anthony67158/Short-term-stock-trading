import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAdviceReviewMemory,
  compareAdviceReviewMemory,
  resolveAdviceReviewMemory,
} from '../shared/adviceReviewMemory.js'
import {
  buildIntradayOpenSummary,
  buildReviewDecisionPacket,
} from '../shared/reviewDecisionPacket.js'

const NOW = Date.parse('2026-08-28T02:10:00.000Z')

function trends() {
  return Array.from({ length: 20 }, (_, index) => ({
    time: `09:${String(31 + index).padStart(2, '0')}`,
    price: 4.5 + index * 0.004,
    vol: index < 10 ? 100 : 180,
    avg: 4.54,
  }))
}

test('开盘至今摘要保留价格路径、VWAP位置和可解释量能比', () => {
  const summary = buildIntradayOpenSummary(trends(), {
    preClose: 4.48,
    observedAt: NOW,
  })

  assert.equal(summary.schemaVersion, 'intraday-open-summary.v1')
  assert.equal(summary.firstTime, '09:31')
  assert.equal(summary.lastTime, '09:50')
  assert.equal(summary.bars, 20)
  assert.equal(summary.priceVsVwap, 'ABOVE')
  assert.equal(summary.directionFromOpen, 'UP')
  assert.equal(summary.volume.state, 'EXPANDING')
  assert.equal(summary.volume.recentToPriorRatio, 1.8)
  assert.equal(summary.path.length, 8)
  assert.equal(summary.path.at(-1).price, summary.currentPrice)
  assert.equal(summary.postTrigger, null)
})

test('持续复核单独保留触价后的均价线恢复路径', () => {
  const triggerAt = Date.parse('2026-08-28T02:02:00.000Z')
  const summary = buildIntradayOpenSummary([
    { time: '10:00', price: 66.7, vol: 100, avg: 66.59 },
    { time: '10:01', price: 66.62, vol: 110, avg: 66.59 },
    { time: '10:02', price: 66.42, vol: 130, avg: 66.59 },
    { time: '10:03', price: 66.61, vol: 160, avg: 66.59 },
    { time: '10:04', price: 66.68, vol: 180, avg: 66.6 },
  ], {
    preClose: 66.5,
    observedAt: Date.parse('2026-08-28T02:04:30.000Z'),
    triggeredAt: triggerAt,
  })

  assert.equal(summary.postTrigger.firstTime, '10:02')
  assert.equal(summary.postTrigger.lastTime, '10:04')
  assert.equal(summary.postTrigger.bars, 3)
  assert.equal(summary.postTrigger.aboveVwapBars, 2)
  assert.equal(summary.postTrigger.reclaimedVwap, true)
  assert.equal(summary.postTrigger.heldAboveVwap, true)
  assert.deepEqual(
    summary.postTrigger.path.map((item) => item.time),
    ['10:02', '10:03', '10:04'],
  )
  const packet = buildReviewDecisionPacket({
    channel: 'FAST_REVIEW',
    code: '600000',
    priorAdvice: {
      action: '观望',
      actionPlan: '回踩66.42元后确认承接',
    },
    event: {
      kind: 'price-review',
      direction: 'lte',
      at: triggerAt,
    },
    current: {
      intradayFromOpen: summary,
    },
  })
  assert.equal(packet.current.postTrigger.reclaimedVwap, true)
  assert.equal(packet.current.postTrigger.heldAboveVwap, true)
})

test('军师结论被编译为下一轮可直接比较的结构化记忆', () => {
  const memory = buildAdviceReviewMemory({
    advice: {
      action: '观望',
      actionPlan: '回踩4.56元不破并重新站回分时均价',
      invalidation: '跌破4.50元取消关注',
      positionNote: '确认后仓位不超过5%',
    },
    payload: {
      intradayOpenSummary: buildIntradayOpenSummary(trends(), {
        preClose: 4.48,
        observedAt: NOW,
      }),
      stockFund: {
        mainNetYi: 0.28,
        retailNetYi: -0.19,
      },
    },
    source: 'ADVISOR',
    now: NOW,
  })

  assert.equal(memory.schemaVersion, 'advice-review-memory.v1')
  assert.equal(memory.market.volumeState, 'EXPANDING')
  assert.equal(memory.market.priceVsVwap, 'ABOVE')
  assert.equal(memory.funds.relation, 'ACCUMULATION')
  assert.equal(memory.conclusion.maxPositionPct, 5)
  assert.match(memory.conclusion.executionCondition, /4\.56元/)
})

test('旧建议只有自然语言时仍可降级解析但标记为旧文本来源', () => {
  const memory = resolveAdviceReviewMemory({
    action: '观望',
    techNote: '回踩缩量，随后重新站回VWAP上方',
    fundNote: '主力净流入，小单净流出',
  })

  assert.equal(memory.source, 'LEGACY_TEXT')
  assert.equal(memory.market.volumeState, 'CONTRACTING')
  assert.equal(memory.market.priceVsVwap, 'ABOVE')
  assert.equal(memory.funds.relation, 'ACCUMULATION')
})

test('分时缺失时使用实时报价量比保守描述量能', () => {
  const memory = buildAdviceReviewMemory({
    advice: { action: '观望' },
    payload: {
      todayQuote: {
        price: 10,
        volRatio: 0.72,
      },
    },
    now: NOW,
  })

  assert.equal(memory.market.volumeState, 'CONTRACTING')
  assert.equal(memory.market.quoteVolumeRatio, 0.72)
})

test('复核记忆明确给出量能、VWAP与资金关系变化', () => {
  const delta = compareAdviceReviewMemory({
    source: 'ADVISOR',
    market: {
      volumeState: 'CONTRACTING',
      priceVsVwap: 'BELOW',
    },
    funds: {
      relation: 'DISTRIBUTION',
      mainNetYi: -0.3,
      retailNetYi: 0.2,
    },
  }, {
    source: 'FAST_REVIEW',
    market: {
      volumeState: 'EXPANDING',
      priceVsVwap: 'ABOVE',
    },
    funds: {
      relation: 'ACCUMULATION',
      mainNetYi: 0.4,
      retailNetYi: -0.1,
    },
  })

  assert.equal(delta.volumeChanged, true)
  assert.equal(delta.vwapChanged, true)
  assert.equal(delta.fundRelationChanged, true)
  assert.equal(delta.mainDeltaYi, 0.7)
  assert.equal(delta.retailDeltaYi, -0.3)
  assert.equal(delta.hasMaterialChange, true)
})

test('快速复核输入包可更新执行细节和后续计划但不能再造观察价', () => {
  const intraday = buildIntradayOpenSummary(trends(), {
    preClose: 4.48,
    observedAt: NOW,
  })
  const packet = buildReviewDecisionPacket({
    channel: 'FAST_REVIEW',
    code: '002177',
    name: '测试股份',
    priorAdvice: {
      planId: 'plan-1',
      action: '观望',
      actionPlan: '回踩4.56元不破并重新站回分时均价',
      invalidation: '跌破4.50元取消关注',
      nextOpenPlan: '确认买入后跌破止损立即退出',
      futurePlan: '第5个交易日前未达目标则退出',
      reviewMemory: {
        source: 'ADVISOR',
        market: {
          volumeState: 'CONTRACTING',
          priceVsVwap: 'BELOW',
        },
        funds: {
          relation: 'DISTRIBUTION',
        },
      },
    },
    event: {
      kind: 'price-review',
      plannedAction: 'PROBE',
      threshold: 4.56,
      price: 4.57,
      maxPositionPct: 5,
    },
    current: {
      quote: { price: 4.57, volRatio: 1.6 },
      funds: { mainNetYi: 0.28, retailNetYi: -0.19 },
      intradayFromOpen: intraday,
      account: { cash: 10000 },
      tactical: {
        market: {
          phase: 'MORNING',
          riskTone: 'RISK_ON',
        },
        actionPolicy: {
          allowedActions: ['BUY', 'WATCH'],
          riskTier: 'PROBE',
          maxPositionPct: 5,
          privateDebug: 'drop-me',
        },
      },
    },
    now: NOW,
  })

  assert.equal(packet.schemaVersion, 'review-decision-packet.v1')
  assert.equal(packet.channel, 'FAST_REVIEW')
  assert.equal(
    packet.requestedDecision.stage,
    'PLAN_REASSESSMENT',
  )
  assert.equal(
    packet.requestedDecision.mayReviseExecutionDetails,
    true,
  )
  assert.equal(
    packet.requestedDecision.mayCreateObservationPrice,
    false,
  )
  assert.equal(packet.priorPlan.maxPositionPct, 5)
  assert.equal(packet.delta.volumeChanged, true)
  assert.deepEqual(
    packet.current.tactical.actionPolicy.allowedActions,
    ['BUY', 'WATCH'],
  )
  assert.equal(
    packet.current.tactical.actionPolicy.privateDebug,
    undefined,
  )
})

test('Judge输入包只确认原计划并继承后续计划', () => {
  const packet = buildReviewDecisionPacket({
    channel: 'JUDGE',
    code: '600000',
    priorAdvice: {
      planId: 'plan-2',
      action: '立即买入',
      actionPlan: '10元买入1手',
      nextOpenPlan: '次日跌破9.7元退出',
      futurePlan: '五日内未达10.8元退出',
      buyPrice: 10,
      stopPrice: 9.7,
      targetPrice: 10.8,
    },
    event: {
      kind: 'judge',
      actionIntent: 'buy',
      threshold: 10,
      price: 10.01,
    },
    current: {
      quote: { price: 10.01 },
      position: { liveQty: 0, sellableToday: 0 },
    },
    now: NOW,
  })

  assert.equal(packet.channel, 'JUDGE')
  assert.equal(
    packet.requestedDecision.stage,
    'EXECUTION_GATE',
  )
  assert.equal(packet.requestedDecision.mayChangeDirection, false)
  assert.equal(
    packet.requestedDecision.followUpPlanSource,
    'PRIOR_PLAN',
  )
  assert.equal(
    packet.priorPlan.nextSessionPlan,
    '次日跌破9.7元退出',
  )
})
