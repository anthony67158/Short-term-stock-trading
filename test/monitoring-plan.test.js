import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachMonitoringPlan,
  compileMonitoringPlan,
  evaluateMonitoringRule,
  monitoringAlerts,
  monitoringView,
  trackedRuleHit,
} from '../shared/monitoringPlan.js'

const now = Date.parse('2026-09-09T02:00:00Z')
const quote = { code: '002475', price: 55.07, prevClose: 54.16, open: 54.2, mainInflow: -1e8, vwap: 55, tradeDate: '2026-09-09', isLivePrice: true }
const rules = [
  { action: 'EXIT', kind: 'RISK_EXIT', lots: 1, logic: 'ANY', conditions: [
    { metric: 'price', op: 'lte', value: 54 }, { metric: 'mainNetYi', op: 'lte', value: -3 },
  ] },
  { action: 'REDUCE', kind: 'PROFIT_EXIT', lots: 1, logic: 'ALL', conditions: [{ metric: 'price', op: 'gte', value: 56 }] },
  { action: 'HOLD', logic: 'ALL', conditions: [{ metric: 'priceVsVwapPct', op: 'gte', value: 0 }, { metric: 'mainNetYi', op: 'gte', value: 0 }] },
]
const advice = { action: '持有', executionRules: rules }
const plan = compileMonitoringPlan({
  advice, payload: { code: '002475', holdQty: 1, todayQuote: quote, tech: { atr: 1.5 } },
  decisionPlan: { mode: 'hold_advice', decisionId: 'decision-test', validUntil: new Date(now + 3600000).toISOString() }, now,
})
advice.monitoringPlan = plan

test('多条件计划以风险退出优先，1手减仓统一为清仓且只有明确规则', () => {
  assert.equal(plan.state, 'READY')
  assert.equal(plan.rules[0].kind, 'RISK_EXIT')
  assert.equal(plan.rules[1].action, 'EXIT')
  assert.equal(plan.rules[2].sustainSeconds, 60)
  const alerts = monitoringAlerts({ holding: [{ code: '002475' }] }, '002475', advice, now)
  assert.equal(alerts.length, 2)
  assert.ok(alerts.every((item) => item.actKind === 'reduce'))
})

test('即时清仓建议清除上一版监控计划并保留本轮操作建议', () => {
  const result = attachMonitoringPlan({
    advice: {
      action: '清仓',
      actionPlan: '清仓1手，参考33.09元人工执行',
      monitoringPlan: plan,
      monitoringRepair: { repaired: false },
    },
    payload: { code: '000063', holdQty: 1 },
    decisionPlan: {
      mode: 'hold_advice',
      action: 'EXIT',
      decisionId: 'exit-now',
      validUntil: new Date(now + 3600000).toISOString(),
    },
    now,
  })

  assert.equal(result.actionPlan, '清仓1手，参考33.09元人工执行')
  assert.equal(result.monitoringPlan, undefined)
  assert.equal(result.monitoringRepair, undefined)
})

test('过期监控计划不再覆盖最新操作建议或继续创建预警', () => {
  const expiredAdvice = {
    ...advice,
    monitoringPlan: {
      ...plan,
      validUntil: new Date(now - 1000).toISOString(),
    },
  }
  assert.equal(monitoringView(expiredAdvice, {
    quote,
    now,
    holdQty: 1,
    sellableTodayQty: 1,
  }), null)
  assert.deepEqual(
    monitoringAlerts(
      { holding: [{ code: '002475' }] },
      '002475',
      expiredAdvice,
      now,
    ),
    [],
  )
})

test('旧监控字段不能覆盖新的即时清仓决策', () => {
  const immediateAdvice = {
    action: '清仓',
    actionPlan: '清仓1手，按当前可卖数量人工执行',
    decisionPlan: {
      mode: 'hold_advice',
      action: 'EXIT',
      decisionId: 'new-immediate-exit',
      validUntil: new Date(now + 3600000).toISOString(),
    },
    monitoringPlan: {
      ...plan,
      planId: 'old-hold-plan',
      validUntil: new Date(now + 3600000).toISOString(),
    },
  }
  assert.equal(monitoringView(immediateAdvice, {
    quote,
    now,
    holdQty: 1,
    sellableTodayQty: 1,
  }), null)
  assert.deepEqual(
    monitoringAlerts(
      { holding: [{ code: '002475' }] },
      '002475',
      immediateAdvice,
      now,
    ),
    [],
  )
})

test('卡片监控合同最多保留三条核心规则', () => {
  const result = compileMonitoringPlan({
    advice: {
      executionRules: [
        ...rules,
        {
          action: 'EXIT',
          kind: 'RISK_EXIT',
          lots: 1,
          logic: 'ANY',
          conditions: [{ metric: 'price', op: 'lte', value: 53.5 }],
        },
      ],
    },
    payload: {
      code: '002475',
      holdQty: 1,
      todayQuote: quote,
      tech: { atr: 1.5 },
    },
    decisionPlan: {
      mode: 'hold_advice',
      action: 'HOLD',
      decisionId: 'three-rule-limit',
      validUntil: new Date(now + 3600000).toISOString(),
    },
    now,
  })

  assert.equal(result.state, 'READY')
  assert.equal(result.rules.length, 3)
  assert.match(result.warnings.join('；'), /超过3条/)
})

test('可选空规则不能拖垮泰坦股份已有的有效退出规则', () => {
  const titanAdvice = {
    action: '持有',
    executionRules: [
      {
        ...rules[0],
        conditions: [{ metric: 'price', op: 'lte', value: 12.8 }],
      },
      {
        ...rules[1],
        conditions: [{ metric: 'price', op: 'gte', value: 15.2 }],
      },
      {
        action: 'HOLD',
        kind: 'HOLD',
        lots: 0,
        logic: 'ALL',
        session: 'CONTINUOUS',
        sustainSeconds: 0,
        conditions: [],
      },
    ],
  }
  const result = compileMonitoringPlan({
    advice: titanAdvice,
    payload: {
      code: '003036',
      holdQty: 1,
      todayQuote: { ...quote, code: '003036', price: 14 },
      tech: { atr: 0.5 },
    },
    decisionPlan: {
      mode: 'hold_advice',
      decisionId: 'titan-rule-3-regression',
      validUntil: new Date(now + 3600000).toISOString(),
    },
    now,
  })

  assert.equal(result.state, 'READY')
  assert.deepEqual(result.errors, [])
  assert.equal(result.rules.length, 2)
  assert.match(result.warnings.join('；'), /rule-3.*空条件.*忽略/)
})

test('不同股票的常见模型结构漂移可修复为有效监控计划', () => {
  const cases = [
    {
      code: '600519',
      name: '贵州茅台',
      holdQty: 2,
      price: 1400,
      atr: 30,
      executionRules: [
        {
          action: '清仓',
          kind: '风险退出',
          lots: '2手',
          logic: '任一',
          session: '连续竞价',
          conditions: { metric: '股价', op: '≤', value: '1320元' },
        },
        {
          action: '减仓',
          kind: '利润退出',
          lots: '1手',
          logic: 'ANY',
          conditions: [{ metric: 'price', op: '>=', value: '1500元' }],
        },
      ],
      expectedRules: 2,
    },
    {
      code: '002594',
      name: '比亚迪',
      holdQty: 3,
      price: 100,
      atr: 3,
      executionRules: [
        {
          action: 'EXIT',
          kind: 'RISK_EXIT',
          lots: 3,
          logic: 'ANY',
          conditions: [{ metric: 'price', op: 'lte', value: 92 }],
        },
        {
          action: 'HOLD',
          kind: 'HOLD',
          lots: 0,
          logic: 'ALL',
          conditions: [{ metric: 'newsSentiment', op: 'gte', value: 1 }],
        },
      ],
      expectedRules: 1,
    },
    {
      code: '688981',
      name: '中芯国际',
      holdQty: 1,
      price: 100,
      atr: 4,
      executionRules: {
        rules: [{
          action: 'EXIT',
          kind: 'RISK_EXIT',
          logic: 'ANY',
          conditions: [{ metric: 'price', op: 'lte', value: 92 }],
        }],
      },
      expectedRules: 1,
    },
    {
      code: '000001',
      name: '平安银行',
      holdQty: 2,
      price: 10,
      atr: 0.3,
      executionRules: [],
      decisionPrices: { stop: 9.6, target: 10.8 },
      expectedRules: 2,
    },
    {
      code: '002475',
      name: '立讯精密',
      holdQty: 1,
      price: 54.5,
      atr: 1.5,
      executionRules: {
        action: 'EXIT',
        kind: 'RISK_EXIT',
        logic: 'ANY',
        conditions: { metric: 'currentPrice', op: '<=', value: 51.8 },
      },
      expectedRules: 1,
    },
    {
      code: '600036',
      name: '招商银行',
      holdQty: 1,
      price: 40,
      atr: 1,
      executionRules: JSON.stringify([{
        action: 'exit',
        kind: 'risk_exit',
        logic: 'any',
        conditions: JSON.stringify({
          field: 'currentPrice',
          operator: '<=',
          threshold: '37.5元',
        }),
      }]),
      expectedRules: 1,
    },
    {
      code: '300750',
      name: '宁德时代',
      holdQty: 4,
      price: 200,
      atr: 6,
      executionRules: [
        { action: 'HOLD', logic: 'ALL', conditions: [] },
        { action: 'EXIT', kind: 'RISK_EXIT', lots: 4, logic: 'ANY', conditions: [{ metric: 'price', op: 'lte', value: 184 }] },
        { action: 'REDUCE', kind: 'PROFIT_EXIT', lots: 1, logic: 'ANY', conditions: [{ metric: 'price', op: 'gte', value: 216 }] },
        { action: 'HOLD', logic: 'ALL', conditions: [{ metric: 'newsSentiment', op: 'gte', value: 1 }] },
        { action: 'HOLD', logic: 'ALL', conditions: [{ metric: 'priceVsVwapPct', op: 'gte', value: 0 }] },
        { action: 'HOLD', logic: 'ALL', conditions: [{ metric: 'openChangePct', op: 'gte', value: 0 }] },
        { action: 'REDUCE', kind: 'PROFIT_EXIT', lots: 1, logic: 'ANY', conditions: [{ metric: 'mainNetYi', op: 'gte', value: 2 }] },
      ],
      expectedRules: 3,
      expectedWarning: true,
    },
  ]

  for (const item of cases) {
    const result = compileMonitoringPlan({
      advice: {
        action: '持有',
        executionRules: item.executionRules,
      },
      payload: {
        code: item.code,
        name: item.name,
        holdQty: item.holdQty,
        todayQuote: { ...quote, code: item.code, price: item.price },
        tech: { atr: item.atr },
      },
      decisionPlan: {
        mode: 'hold_advice',
        decisionId: `matrix-${item.code}`,
        validUntil: new Date(now + 3600000).toISOString(),
        prices: item.decisionPrices || {},
      },
      now,
    })
    assert.equal(result.state, 'READY', `${item.code} ${result.errors.join('；')}`)
    assert.equal(result.rules.length, item.expectedRules, item.code)
    if (item.expectedWarning) assert.ok(result.warnings.length > 0, item.code)
  }
})

test('模型没有可用规则且没有价格锚点时关闭跟踪而不编造止损', () => {
  const original = {
    action: '持有',
    title: '继续持有1手',
    actionPlan: '继续持有，等待有效退出条件',
    nextAction: '继续持有，等待有效退出条件',
    executionRules: [{
      action: 'HOLD',
      kind: 'HOLD',
      logic: 'ALL',
      conditions: [{ metric: 'newsSentiment', op: 'gte', value: 1 }],
    }],
  }
  const result = attachMonitoringPlan({
    advice: original,
    payload: {
      code: '003036',
      holdQty: 1,
      todayQuote: { ...quote, code: '003036', price: 14 },
      tech: { atr: 0.5 },
    },
    decisionPlan: {
      mode: 'hold_advice',
      action: 'HOLD',
      decisionId: 'titan-unavailable-monitoring',
      validUntil: new Date(now + 3600000).toISOString(),
      prices: {},
    },
    now,
  })

  assert.equal(result.title, original.title)
  assert.equal(result.monitoringPlan.state, 'INVALID')
  assert.equal(result.monitoringRepair.unavailable, true)
  assert.equal(result.monitoringPlan.rules.length, 0)
  assert.equal(result.actionPlan, original.actionPlan)
  assert.match(result.monitoringPlan.errors.join('；'), /缺少可执行/)
})

test('监控规则归一化矩阵不会因可解释格式漂移整批失败', () => {
  const actions = [
    ['EXIT', 'RISK_EXIT', 1],
    ['清仓', '风险退出', '1手'],
    ['SELL_ALL', 'STOP_LOSS', null],
  ]
  const conditions = [
    [{ metric: 'price', op: 'lte', value: 12.8 }],
    { metric: '股价', op: '≤', value: '12.8元' },
    { field: 'currentPrice', operator: '<=', threshold: '12.8' },
  ]

  for (const [action, kind, lots] of actions) {
    for (const condition of conditions) {
      const result = compileMonitoringPlan({
        advice: {
          executionRules: {
            rules: [{
              action,
              kind,
              lots,
              logic: Array.isArray(condition) ? 'ANY' : '任一',
              conditions: condition,
            }],
          },
        },
        payload: {
          code: '003036',
          holdQty: 1,
          todayQuote: { ...quote, code: '003036', price: 14 },
          tech: { atr: 0.5 },
        },
        decisionPlan: {
          mode: 'hold_advice',
          decisionId: `matrix-${action}-${kind}`,
          validUntil: new Date(now + 3600000).toISOString(),
        },
        now,
      })
      assert.equal(result.state, 'READY', `${action}/${kind}/${JSON.stringify(condition)}`)
      assert.equal(result.rules[0].action, 'EXIT')
      assert.equal(result.rules[0].conditions[0].metric, 'price')
      assert.equal(result.rules[0].conditions[0].op, 'lte')
      assert.equal(result.rules[0].conditions[0].value, 12.8)
    }
  }
})

test('监控编译器面对畸形模型字段不抛异常且不编造价格', () => {
  const malformed = [
    null,
    '',
    'not-json',
    {},
    { rules: null },
    [null],
    [42, false, 'bad-rule'],
    [{ action: 'UNKNOWN', logic: '???', conditions: 'not-json' }],
    [{ action: 'EXIT', logic: 'ALL', conditions: Array.from({ length: 5 }, () => ({})) }],
  ]

  for (const executionRules of malformed) {
    const result = compileMonitoringPlan({
      advice: { executionRules },
      payload: {
        code: '003036',
        holdQty: 1,
        todayQuote: { ...quote, code: '003036', price: 14 },
        tech: { atr: 0.5 },
      },
      decisionPlan: {
        mode: 'hold_advice',
        decisionId: 'malformed-input',
        validUntil: new Date(now + 3600000).toISOString(),
        prices: {},
      },
      now,
    })
    assert.equal(result.state, 'INVALID')
    assert.equal(result.rules.length, 0)
    assert.match(result.errors.join('；'), /缺少可执行/)
  }
})

test('任意畸形附加规则都不能拖垮已有的有效退出规则', () => {
  const actions = [null, '', 'UNKNOWN', 'HOLD', '持有', 'REDUCE', '减仓', 42]
  const logics = [null, '', 'ALL', '任一', '???']
  const conditionShapes = [
    null,
    [],
    {},
    'not-json',
    { metric: 'unknownMetric', op: 'gte', value: 1 },
    { metric: 'price', op: 'lte', value: '12.5元' },
    Array.from({ length: 5 }, () => ({ metric: 'price', op: 'lte', value: 12.5 })),
  ]
  let checked = 0

  for (const action of actions) {
    for (const logic of logics) {
      for (const conditions of conditionShapes) {
        const result = compileMonitoringPlan({
          advice: {
            executionRules: [{
              action: 'EXIT',
              kind: 'RISK_EXIT',
              lots: 3,
              logic: 'ANY',
              conditions: [{ metric: 'price', op: 'lte', value: 12.8 }],
            }, {
              action,
              logic,
              conditions,
            }],
          },
          payload: {
            code: '003036',
            holdQty: 3,
            todayQuote: { ...quote, code: '003036', price: 14 },
            tech: { atr: 0.5 },
          },
          decisionPlan: {
            mode: 'hold_advice',
            decisionId: `extra-${checked}`,
            validUntil: new Date(now + 3600000).toISOString(),
          },
          now,
        })
        assert.equal(result.state, 'READY')
        assert.ok(result.rules.some((rule) => rule.action === 'EXIT'))
        checked += 1
      }
    }
  }
  assert.equal(checked, 280)
})

test('只有持有描述且没有价格锚点时关闭自动跟踪', () => {
  const repaired = compileMonitoringPlan({
    advice: { executionRules: [rules[2]] },
    payload: { code: '002475', holdQty: 1, todayQuote: quote, tech: { atr: 1.5 } },
    decisionPlan: { mode: 'hold_advice', decisionId: 'invalid', validUntil: new Date(now + 3600000).toISOString() },
    now,
  })
  assert.equal(repaired.state, 'INVALID')
  assert.equal(repaired.rules.filter((rule) => rule.kind === 'RISK_EXIT').length, 0)
  assert.match(repaired.errors.join('；'), /缺少可执行/)
})

test('缺少行情成本和技术依据时不编造保护性价格', () => {
  const invalid = compileMonitoringPlan({
    advice: { executionRules: [rules[2]] },
    payload: { code: '002475', holdQty: 1 },
    decisionPlan: {
      mode: 'hold_advice',
      decisionId: 'missing-all-price-evidence',
      validUntil: new Date(now + 3600000).toISOString(),
      prices: {},
    },
    now,
  })
  assert.equal(invalid.state, 'INVALID')
  assert.equal(invalid.rules.filter((rule) => rule.action !== 'HOLD').length, 0)
  assert.match(invalid.errors.join('；'), /缺少可执行的减仓或清仓规则/)
})

test('资金条件独立命中OR退出，缺失资金不能当零或当作已确认', () => {
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, mainInflow: -3.1e8 }, { now }).matched, true)
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, price: 53.99 }, { now }).matched, true)
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, mainInflow: null }, { now }).state, 'MISSING_DATA')
  assert.equal(evaluateMonitoringRule(plan.rules[0], { ...quote, isLivePrice: false }, { now }).matched, false)
})

test('高点回撤使用正百分比并按向上阈值触发风险退出', () => {
  const drawdownPlan = compileMonitoringPlan({
    advice: {
      executionRules: [{
        action: 'REDUCE',
        lots: 1,
        logic: 'ANY',
        conditions: [{
          metric: 'drawdownFromHighPct',
          op: 'gte',
          value: 3,
        }],
      }],
    },
    payload: {
      code: '002475',
      holdQty: 2,
      todayQuote: quote,
    },
    decisionPlan: {
      mode: 'hold_advice',
      decisionId: 'drawdown-positive',
      validUntil: new Date(now + 3600000).toISOString(),
    },
    now,
  })

  assert.equal(drawdownPlan.state, 'READY')
  assert.equal(drawdownPlan.rules[0].kind, 'RISK_EXIT')
  assert.equal(evaluateMonitoringRule(
    drawdownPlan.rules[0],
    { ...quote, price: 96, high: 100 },
    { now },
  ).matched, true)
})

test('站稳均价线必须连续60秒，数据断档或跌回即重新计时', () => {
  const strong = { ...quote, mainInflow: 1e8 }
  const first = evaluateMonitoringRule(plan.rules[2], strong, { now })
  assert.equal(first.state, 'OBSERVING')
  assert.equal(evaluateMonitoringRule(plan.rules[2], strong, { now: now + 60000, previous: first }).matched, true)
  assert.equal(evaluateMonitoringRule(plan.rules[2], strong, { now: now + 120000, previous: first }).matched, false)
  assert.equal(evaluateMonitoringRule(plan.rules[2], { ...strong, price: 54 }, { now: now + 30000, previous: first }).matchedSince, 0)
})

test('到价观察视图返回真实倒计时与运行态时间锚点', () => {
  const strong = { ...quote, mainInflow: 1e8 }
  const first = evaluateMonitoringRule(plan.rules[2], strong, { now })
  const alerts = monitoringAlerts(
    { holding: [{ code: '002475' }] },
    '002475',
    advice,
    now,
  )
  const view = monitoringView(advice, {
    quote: strong,
    alerts,
    previousStates: new Map([[plan.rules[2].id, first]]),
    now: now + 15000,
    holdQty: 1,
    sellableTodayQty: 1,
  })
  const observing = view.monitoring.rules.find((rule) => rule.id === plan.rules[2].id)
  assert.equal(view.monitoring.observing, true)
  assert.match(view.instruction, /到价观察中/)
  assert.equal(observing.state, 'OBSERVING')
  assert.equal(observing.remainingSeconds, 45)
  assert.equal(observing.runtimeState.matchedSince, now)
  const completed = monitoringView(advice, {
    quote: strong,
    alerts,
    previousStates: new Map([[plan.rules[2].id, first]]),
    now: now + 60000,
    holdQty: 1,
    sellableTodayQty: 1,
  })
  assert.equal(completed.monitoring.observing, false)
  assert.equal(
    completed.monitoring.rules.find((rule) => rule.id === plan.rules[2].id).state,
    'MATCHED',
  )
})

test('卡片只展示监控动作，不显示无关加仓价；提醒必须有实际触发记录', () => {
  const alerts = monitoringAlerts({ holding: [{ code: '002475' }] }, '002475', advice, now)
  const waiting = monitoringView(advice, { quote, alerts, now, holdQty: 1, sellableTodayQty: 1 })
  assert.equal(waiting.action, '继续持有')
  assert.deepEqual(waiting.levels, [])
  assert.equal(waiting.actionable, false)
  const hit = trackedRuleHit(alerts[0], { ...quote, price: 53.9 }, now)
  assert.match(hit, /54元/)
  Object.assign(alerts[0], { triggeredAt: now, phase: 'triggered', triggeredMsg: hit, enabled: false })
  const triggered = monitoringView(advice, { quote, alerts, now, holdQty: 1, sellableTodayQty: 1 })
  assert.equal(triggered.action, '清仓')
  assert.equal(triggered.quantity, '1手')
  assert.equal(monitoringView(advice, { quote, alerts, now, holdQty: 1, sellableTodayQty: 0 }).actionable, false)
})
