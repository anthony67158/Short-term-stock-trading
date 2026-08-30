import test from 'node:test'
import assert from 'node:assert/strict'

import { projectAdviceAlerts } from '../shared/adviceAlerts.js'

const now = 1786080000000
const ids = (() => {
  let n = 0
  return () => `alert_${++n}`
})()

test('云端买入建议会生成候选买点预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '600519', {
    name: '贵州茅台',
    buyPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.equal(data.alerts.length, 1)
  assert.deepEqual(data.alerts[0], {
    id: 'alert_1',
    enabled: true,
    createdAt: now,
    triggeredAt: null,
    triggeredMsg: '',
    code: '600519',
    name: '贵州茅台',
    type: 'price',
    op: 'lte',
    value: 1400,
    note: '买点',
    candCode: '600519',
    phase: 'armed',
  })
  assert.equal(data.plan[0].alertSyncedPrice, 1400)
})

test('新建议预警只采用价格契约中的精确执行价', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '600519', {
    name: '贵州茅台',
    action: '立即买入',
    buyPrice: 1400,
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'entry',
        field: 'buyPrice',
        purpose: 'ENTRY',
        price: 1398.5,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
        basis: 'technical.buyZone.high',
        basisPrice: 1398.5,
        basisDistancePct: 0,
        tolerancePct: 1,
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ALL', conditions: [], allMet: false },
    },
  }, { now, idFactory: ids })

  assert.equal(data.alerts.length, 1)
  assert.equal(data.alerts[0].value, 1398.5)
  assert.equal(
    data.alerts[0].judgeContext.priceContract.levels[0].price,
    1398.5,
  )
})

test('价格契约未通过时不得创建交易预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '600519', {
    action: '立即买入',
    buyPrice: 1400,
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      validationStatus: 'REJECTED',
      levels: [{
        key: 'entry',
        field: 'buyPrice',
        purpose: 'ENTRY',
        price: 1400,
        direction: 'LTE',
        status: 'PENDING',
        strict: false,
      }],
      allPricesStrict: false,
      issues: ['buyPrice缺少邻近行情、技术或量化锚点'],
      review: { operator: 'ALL', conditions: [], allMet: false },
    },
  }, { now, idFactory: ids })

  assert.equal(data.alerts.length, 0)
})

test('生产投影拒绝旧建议继续创建无价格契约的自动预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [{
      id: 'legacy-auto',
      code: '600519',
      candCode: '600519',
      type: 'price',
      op: 'lte',
      value: 1400,
      enabled: true,
    }],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '600519', {
    action: '立即买入',
    buyPrice: 1400,
  }, {
    now,
    idFactory: ids,
    requirePriceContract: true,
  })

  assert.equal(changed, true)
  assert.equal(data.alerts.length, 0)
})

test('未持仓观望建议生成复核价提醒而不是买点提醒', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '600519', {
    action: '观望',
    watchPrice: 145.24,
    reviewMemory: {
      schemaVersion: 'advice-review-memory.v1',
      source: 'ADVISOR',
      conclusion: {
        action: '观望',
        executionCondition: '观察价到达后复核',
        maxPositionPct: 5,
      },
      market: {},
      funds: {},
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'watch',
        field: 'watchPrice',
        purpose: 'REVIEW_ONLY',
        price: 145.24,
        direction: 'GTE',
        status: 'PENDING',
        strict: true,
        basis: 'technical.resistance',
        basisPrice: 145.24,
        basisDistancePct: 0,
        tolerancePct: 2,
      }],
      allPricesStrict: true,
      issues: [],
      review: {
        operator: 'ALL',
        conditions: [{
          key: 'WATCH_PRICE',
          direction: 'GTE',
          price: 145.24,
          status: 'PENDING',
          strict: true,
        }],
        allMet: false,
      },
    },
  }, {
    now,
    idFactory: ids,
    requirePriceContract: true,
  })

  assert.equal(data.alerts.length, 1)
  assert.equal(data.alerts[0].reviewOnly, true)
  assert.equal(data.alerts[0].note, '突破观察')
  assert.equal(data.alerts[0].op, 'gte')
  assert.equal(data.alerts[0].value, 145.24)
  assert.equal(data.alerts[0].candCode, '600519')
  assert.equal(data.alerts[0].reviewIntent.maxPositionPct, 5)
})

test('未持仓观望为回踩与突破分别生成复核提醒', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '600519', {
    action: '观望',
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      currentPrice: 100,
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'watch_pullback',
        field: 'pullbackWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '回踩观察',
        price: 96,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
      }, {
        key: 'watch_breakout',
        field: 'breakoutWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '突破观察',
        price: 105,
        direction: 'GTE',
        status: 'PENDING',
        strict: true,
      }],
      allPricesStrict: true,
      issues: [],
      review: {
        operator: 'ANY',
        conditions: [],
        allMet: false,
      },
    },
  }, {
    now,
    idFactory: ids,
    requirePriceContract: true,
  })

  assert.deepEqual(data.alerts.map((alert) => [
    alert.reviewKey,
    alert.note,
    alert.op,
    alert.value,
  ]), [
    ['watch_pullback', '回踩观察', 'lte', 96],
    ['watch_breakout', '突破观察', 'gte', 105],
  ])
})

test('新建议发布后重新武装旧的reviewing观察价', () => {
  const data = {
    plan: [{ code: '600601', name: '方正科技' }],
    holding: [],
    alerts: [{
      id: 'old-review',
      code: '600601',
      name: '方正科技',
      candCode: '600601',
      reviewOnly: true,
      reviewKey: 'watch_pullback',
      enabled: false,
      phase: 'reviewing',
      op: 'lte',
      value: 12.31,
      triggeredAt: 1_000,
      triggeredMsg: '旧触价结果',
      decisionPrice: 11.66,
      judgeContext: {
        planId: 'plan-600601',
        planRevision: 1,
      },
    }, {
      id: 'old-breakout',
      code: '600601',
      name: '方正科技',
      candCode: '600601',
      reviewOnly: true,
      reviewKey: 'watch_breakout',
      enabled: false,
      phase: 'superseded',
      op: 'gte',
      value: 12.56,
      triggeredAt: null,
      judgeContext: {
        planId: 'plan-600601',
        planRevision: 1,
      },
    }],
    settings: {},
  }
  const advice = {
    action: '观望',
    continuity: {
      planId: 'plan-600601',
      revision: 2,
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      currentPrice: 12.49,
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'watch_pullback',
        field: 'pullbackWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '回踩观察',
        price: 12.31,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
      }, {
        key: 'watch_breakout',
        field: 'breakoutWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '突破观察',
        price: 12.56,
        direction: 'GTE',
        status: 'PENDING',
        strict: true,
      }],
      allPricesStrict: true,
      issues: [],
      review: {
        operator: 'ANY',
        conditions: [],
        allMet: false,
      },
    },
  }

  projectAdviceAlerts(data, '600601', advice, {
    now: 2_100,
    adviceAt: 2_000,
    idFactory: ids,
    requirePriceContract: true,
  })

  assert.deepEqual(data.alerts.map((alert) => ({
    id: alert.id,
    enabled: alert.enabled,
    phase: alert.phase,
    triggeredAt: alert.triggeredAt,
    triggeredMsg: alert.triggeredMsg,
    decisionPrice: alert.decisionPrice,
    planRevision: alert.judgeContext.planRevision,
  })), [{
    id: 'old-review',
    enabled: true,
    phase: 'armed',
    triggeredAt: null,
    triggeredMsg: '',
    decisionPrice: null,
    planRevision: 2,
  }, {
    id: 'old-breakout',
    enabled: true,
    phase: 'armed',
    triggeredAt: null,
    triggeredMsg: '',
    decisionPrice: null,
    planRevision: 2,
  }])
})

test('盘后旧买入计划只生成下一交易时段观察提醒', () => {
  const data = {
    plan: [{ code: '000737', name: '北方铜业' }],
    holding: [],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000737', {
    action: '立即买入',
    buyPrice: 15.69,
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      action: 'BUY',
      evidenceBasis: {
        isLive: false,
        phase: '盘后(已收盘)',
      },
      actionPolicy: {
        executionOpen: false,
      },
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      currentPrice: 15.44,
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'entry',
        field: 'buyPrice',
        purpose: 'ENTRY',
        price: 15.69,
        direction: 'LTE',
        status: 'MET',
        strict: true,
        basis: 'technical.resistance',
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ALL', conditions: [], allMet: false },
    },
  }, {
    now,
    idFactory: ids,
    requirePriceContract: true,
  })

  assert.equal(data.alerts.length, 1)
  assert.equal(data.alerts[0].reviewOnly, true)
  assert.equal(data.alerts[0].reviewKey, 'watch_breakout')
  assert.equal(data.alerts[0].op, 'gte')
  assert.equal(data.alerts[0].value, 15.69)
  assert.equal(data.alerts[0].note, '突破观察')
})

test('未持仓自选股只生成买点预警，禁止生成加仓或减仓预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [{
      id: 'stale-add',
      code: '600519',
      actCode: '600519',
      actKind: 'add',
      enabled: true,
    }],
    settings: {},
  }

  projectAdviceAlerts(data, '600519', {
    name: '贵州茅台',
    action: '立即买入',
    buyPrice: 1400,
    addPrice: 1380,
    reducePrice: 1500,
  }, { now, idFactory: ids })

  assert.equal(data.alerts.length, 1)
  assert.equal(data.alerts[0].candCode, '600519')
  assert.equal(data.alerts[0].note, '买点')
  assert.equal(data.alerts[0].actKind, undefined)
})

test('云端持仓建议会生成补仓和减仓行动预警', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000001', {
    name: '平安银行',
    action: '加仓',
    addPrice: 10.12,
    reducePrice: 11.36,
    opQty: '减1手',
    exitTiming: '站稳均价线再操作',
    stopPrice: 9.8,
    targetPrice: 12,
    riskReward: '2:1',
    fundNote: '主力资金流入',
    invalidation: '跌破9.8元失效',
  }, { now, idFactory: ids })

  assert.equal(data.alerts.length, 2)
  assert.deepEqual(data.alerts.map((a) => [a.actKind, a.op, a.value]), [
    ['add', 'lte', 10.12],
    ['reduce', 'gte', 11.36],
  ])
  assert.equal(data.alerts[0].timing, '站稳均价线再操作')
  assert.equal(data.alerts[0].judgeContext.action, '加仓')
  assert.equal(data.alerts[0].judgeContext.stopPrice, 9.8)
  assert.equal(data.alerts[0].judgeContext.riskReward, '2:1')
  assert.equal(data.alerts[0].judgeContext.fundNote, '主力资金流入')
})

test('今日新建仓的减仓预警标记为 T+1 锁定且不能提示卖出', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000636', name: '风华高科' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000636', {
    addPrice: 13,
    reducePrice: 14,
    opQty: '减仓1手',
  }, {
    now,
    idFactory: ids,
    t1Status: { liveQty: 1, boughtToday: 1, sellableToday: 0 },
  })

  const reduce = data.alerts.find((alert) => alert.actKind === 'reduce')
  assert.equal(reduce.name, '风华高科')
  assert.equal(reduce.t1Blocked, true)
  assert.equal(reduce.sellableTodayQty, 0)
  assert.equal(reduce.opQty, '今日不可卖')
})

test('T+1导致减仓降级为持有时不生成方向相反的加仓复核提醒', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '990008', name: '沧澜动力' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '990008', {
    action: '持有',
    actionPlan: '今日无可卖仓位，继续持有等待下一交易日',
    nextAction: '下一交易日优先减仓降低风险',
    opQty: '无需操作',
    reducePrice: 10.8,
    shortHorizonTactical: {
      timing: {
        pullbackPrice: 10.1,
        breakoutPrice: 10.9,
      },
      actionPolicy: {
        riskTier: 'FULL',
        canIncreaseRisk: true,
      },
    },
  }, {
    now,
    idFactory: ids,
    t1Status: {
      liveQty: 2,
      boughtToday: 2,
      sellableToday: 0,
    },
  })

  assert.equal(
    data.alerts.some((alert) => alert.reviewOnly === true),
    false,
  )
  assert.equal(
    data.alerts.some((alert) => alert.actKind === 'reduce'),
    true,
  )
})

test('旧仓2手今日补1手时减仓预警最多提示2手', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000636', name: '风华高科' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '000636', {
    reducePrice: 14,
    opQty: '减仓3手',
  }, {
    now,
    idFactory: ids,
    t1Status: { liveQty: 3, boughtToday: 1, sellableToday: 2 },
  })

  const reduce = data.alerts.find((alert) => alert.actKind === 'reduce')
  assert.equal(reduce.t1Blocked, false)
  assert.equal(reduce.opQty, '减仓2手')
})

test('相同价位保留旧预警状态并刷新Judge建议快照', () => {
  const old = {
    id: 'old',
    code: '000001',
    actCode: '000001',
    actKind: 'add',
    type: 'price',
    op: 'lte',
    value: 10.12,
    phase: 'watching',
    enabled: true,
  }
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行' }],
    alerts: [old],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '000001', {
    addPrice: 10.12,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.equal(data.alerts[0].id, 'old')
  assert.equal(data.alerts[0].phase, 'watching')
  assert.equal(data.alerts[0].judgeContext.addPrice, 10.12)
})

test('同一主计划调价时保留观察状态并改用动态价格带', () => {
  const old = {
    id: 'stable-plan-alert',
    code: '000001',
    actCode: '000001',
    actKind: 'add',
    type: 'price',
    op: 'lte',
    value: 10.06,
    phase: 'watching',
    watchingAt: now - 60000,
    enabled: true,
    judgeContext: {
      planId: 'plan-000001',
      planRevision: 2,
    },
  }
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '000001', name: '平安银行' }],
    alerts: [old],
    settings: {},
  }

  projectAdviceAlerts(data, '000001', {
    action: '加仓',
    addPrice: 10.2,
    continuity: {
      planId: 'plan-000001',
      revision: 3,
      thesisVersion: 1,
      changeType: 'adjust',
      zones: {
        add: { low: 10.14, high: 10.26, anchor: 10.2 },
      },
    },
  }, { now, idFactory: ids })

  assert.equal(data.alerts[0].id, 'stable-plan-alert')
  assert.equal(data.alerts[0].phase, 'watching')
  assert.equal(data.alerts[0].watchingAt, now - 60000)
  assert.equal(data.alerts[0].value, 10.26)
  assert.deepEqual(data.alerts[0].triggerZone, {
    low: 10.14,
    high: 10.26,
    anchor: 10.2,
  })
  assert.equal(data.alerts[0].judgeContext.planRevision, 3)
})

test('关闭 AI 自动预警时清理该股票的自动预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [
      { id: 'auto', code: '600519', candCode: '600519' },
      { id: 'manual', code: '600519', type: 'pct' },
    ],
    settings: { aiAutoAlert: false },
  }

  const changed = projectAdviceAlerts(data, '600519', {
    buyPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.deepEqual(data.alerts, [{ id: 'manual', code: '600519', type: 'pct' }])
})

test('单股关闭持续复核时清理军师派生预警但保留手工预警', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [
      { id: 'auto', code: '600519', candCode: '600519' },
      { id: 'manual', code: '600519', type: 'pct' },
    ],
    settings: { 'advReview.disabledCodes': ['600519'] },
  }

  const changed = projectAdviceAlerts(data, '600519', {
    buyPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.deepEqual(data.alerts, [{ id: 'manual', code: '600519', type: 'pct' }])
})

test('股票已移出自选和持仓时不会从旧建议重建预警', () => {
  const data = {
    plan: [],
    holding: [],
    alerts: [
      { id: 'old', code: '600519', actCode: '600519', actKind: 'add' },
      { id: 'manual', code: '600519', type: 'pct' },
    ],
    settings: {},
  }

  const changed = projectAdviceAlerts(data, '600519', {
    addPrice: 1400,
  }, { now, idFactory: ids })

  assert.equal(changed, true)
  assert.deepEqual(data.alerts, [{ id: 'manual', code: '600519', type: 'pct' }])
})

test('军师主结论已是减仓时不再创建备用加仓预警', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '600000', name: '浦发银行' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '600000', {
    action: '减仓',
    actionPlan: '反弹到11元减仓1手',
    addPrice: 9.8,
    reducePrice: 11,
  }, { now, idFactory: ids })

  assert.deepEqual(data.alerts.map((alert) => alert.actKind), ['reduce'])
})

test('持有建议持续创建回踩与突破两条加仓复核提醒', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '003036', name: '泰坦股份' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '003036', {
    action: '持有',
    actionPlan: '当前持有，本轮不直接加仓',
    shortHorizonTactical: {
      timing: {
        pullbackPrice: 50.94,
        breakoutPrice: 52.06,
      },
      actionPolicy: {
        riskTier: 'NONE',
        canIncreaseRisk: false,
        reasons: ['量化与流动性尚未确认'],
      },
    },
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      currentPrice: 51.82,
      validationStatus: 'VERIFIED',
      allPricesStrict: true,
      levels: [{
        key: 'stop',
        field: 'stopPrice',
        price: 50.89,
        direction: 'LTE',
        strict: true,
        basis: 'quote.dayLow',
      }],
    },
    stopPrice: 50.89,
  }, {
    now,
    idFactory: ids,
    requirePriceContract: true,
    t1Status: {
      liveQty: 1,
      boughtToday: 1,
      sellableToday: 0,
    },
  })

  const reviews = data.alerts.filter((alert) => alert.reviewOnly)
  assert.deepEqual(
    reviews.map((alert) => [
      alert.reviewKey,
      alert.op,
      alert.value,
      alert.note,
    ]),
    [
      ['holding_add_pullback', 'lte', 50.94, '回踩加仓复核'],
      ['holding_add_breakout', 'gte', 52.06, '突破加仓复核'],
    ],
  )
  assert.equal(
    reviews.every((alert) =>
      alert.actCode === '003036'
      && alert.reviewIntent.mode === 'REASSESSMENT'
    ),
    true,
  )
})

test('跌破型减仓使用向下预警而不是把高于触发线误判为到价', () => {
  const data = {
    plan: [],
    holding: [{ id: 'h1', code: '002436', name: '兴森科技' }],
    alerts: [],
    settings: {},
  }

  projectAdviceAlerts(data, '002436', {
    action: '减仓',
    actionPlan: '触及31.82元且30至60分钟不能收回，卖出1手',
    reducePrice: 31.82,
    opQty: '减仓1手',
  }, { now, idFactory: ids })

  const [alert] = data.alerts
  assert.equal(alert.actKind, 'reduce')
  assert.equal(alert.op, 'lte')
  assert.equal(alert.value, 31.82)
})

test('到价终局复核完成后清除原价格链且不创建新复核价', () => {
  const data = {
    plan: [{ code: '600519', name: '贵州茅台' }],
    holding: [],
    alerts: [{
      id: 'old-review',
      code: '600519',
      candCode: '600519',
      reviewOnly: true,
      enabled: false,
      phase: 'reviewing',
      value: 145.24,
    }],
    settings: {},
  }

  projectAdviceAlerts(data, '600519', {
    action: '观望',
    title: '维持观望',
    reviewDecision: {
      schemaVersion: 'triggered-review-decision.v1',
      terminal: true,
      outcome: '维持观望',
    },
    pullbackWatchPrice: null,
    breakoutWatchPrice: null,
  }, { now, idFactory: ids })

  assert.deepEqual(data.alerts, [])
  assert.equal(data.plan[0].alertSyncedPrice, null)
  assert.equal(data.plan[0].reviewSyncedPrice, null)
  assert.equal(data.plan[0].reviewSyncedPrices, null)
})
