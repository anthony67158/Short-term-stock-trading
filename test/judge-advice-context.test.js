import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionIntentOf,
  actionLabelOf,
  adviceSupportsIntent,
  buildJudgeAdviceContext,
} from '../shared/judgeAdviceContext.js'

test('加仓预警保留独立动作语义，不降级成普通买入', () => {
  const alert = { actKind: 'add', note: '补仓点' }

  assert.equal(actionIntentOf(alert), 'add')
  assert.equal(actionLabelOf(alert), '加仓')
})

test('Judge建议快照覆盖军师的方向、风控、仓位与多维依据', () => {
  const context = buildJudgeAdviceContext({
    action: '加仓',
    actionPlan: '回踩10元加仓1手',
    addPrice: 10,
    stopPrice: 9.6,
    targetPrice: 11,
    riskReward: '2.5:1',
    positionNote: '加仓后单票不超过20%',
    techNote: '站上MA10',
    fundNote: '主力连续流入',
    newsNote: '无明显利空',
    quantNote: '量化上涨概率62%',
    bearCase: '板块转弱',
    invalidation: '跌破9.6元',
  })

  assert.deepEqual(context, {
    action: '加仓',
    tier: '',
    title: '',
    actionPlan: '回踩10元加仓1手',
    exitTiming: '',
    opQty: '',
    addPrice: 10,
    reducePrice: null,
    stopPrice: 9.6,
    targetPrice: 11,
    riskReward: '2.5:1',
    positionNote: '加仓后单票不超过20%',
    reason: '',
    techNote: '站上MA10',
    fundNote: '主力连续流入',
    newsNote: '无明显利空',
    quantNote: '量化上涨概率62%',
    bearCase: '板块转弱',
    invalidation: '跌破9.6元',
    confidence: '',
  })
})

test('Judge建议快照保留生成时的主力与散户资金基准', () => {
  const context = buildJudgeAdviceContext({
    action: '立即买入',
    fundContext: {
      source: 'realtime',
      fetchedAt: 1000,
      asOfDate: '2026-08-28',
      mainNetYi: 0.8,
      retailNetYi: -0.3,
      mainTrend5: [0.1, 0.2, 0.3, 0.5, 0.7],
      retailTrend5: [-0.1, -0.1, -0.2, -0.2, -0.3],
    },
  })

  assert.equal(context.fundContext.source, 'realtime')
  assert.equal(context.fundContext.mainNetYi, 0.8)
  assert.equal(context.fundContext.retailNetYi, -0.3)
  assert.deepEqual(
    context.fundContext.retailTrend5,
    [-0.1, -0.1, -0.2, -0.2, -0.3],
  )
})

test('军师明确写不加仓或赔率不足时不能创建加仓提醒', () => {
  assert.equal(adviceSupportsIntent('add', {
    action: '持有',
    addPrice: 10,
    actionPlan: '回踩10元也暂不加仓，继续观察',
  }), false)
  assert.equal(adviceSupportsIntent('add', {
    action: '持有',
    addPrice: 10,
    riskReward: '盈亏比1.2:1，赔率不足，因此不新增仓位',
  }), false)
})

test('Judge上下文保留用户选择、实际运行模型与V2.1实验可靠性', () => {
  const context = buildJudgeAdviceContext({
    action: '小仓试错',
    quantContext: {
      selectedModelVersion: 'v2.1',
      effectiveModelVersion: 'v2.1',
      runtimeModelVersion: 'v2.1-intraday',
      modelLabel: '分钟 Transformer V2.1（盘中实验）',
      horizon: '未来30分钟',
      asOf: '2026-08-12 10:30:00',
      experimental: true,
      fallback: null,
      reliability: {
        productionGatePassed: false,
        thresholdPct: 58,
        balancedAccuracyPct: {
          next30m: 53.92,
          sessionClose: 54.58,
        },
      },
    },
  })

  assert.deepEqual(context.quantContext, {
    selectedModelVersion: 'v2.1',
    effectiveModelVersion: 'v2.1',
    runtimeModelVersion: 'v2.1-intraday',
    modelLabel: '分钟 Transformer V2.1（盘中实验）',
    horizon: '未来30分钟',
    asOf: '2026-08-12 10:30:00',
    experimental: true,
    fallback: null,
    reliability: {
      productionGatePassed: false,
      thresholdPct: 58,
      balancedAccuracyPct: {
        next30m: 53.92,
        sessionClose: 54.58,
      },
    },
  })
})

test('Judge上下文只保留服务端验证后的价格契约', () => {
  const context = buildJudgeAdviceContext({
    action: '立即买入',
    buyPrice: 10,
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      asOf: '2026-08-25T02:00:00.000Z',
      evidenceSnapshotId: 'ev-price-1',
      currentPrice: 10.2,
      legalRange: { low: 9, high: 11 },
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
        hidden: 'drop-me',
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ALL', conditions: [], allMet: false },
      secret: 'drop-me',
    },
  })

  assert.equal(
    context.priceContract.schemaVersion,
    'advice-price-contract.v1',
  )
  assert.equal(context.priceContract.levels[0].price, 10)
  assert.equal(context.priceContract.levels[0].basis, 'technical.buyZone.high')
  assert.equal(context.priceContract.levels[0].hidden, undefined)
  assert.equal(context.priceContract.secret, undefined)
})
