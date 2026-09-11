import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decisionPresentation,
  decisionPrices,
} from '../shared/decisionPresentation.js'

const now = Date.parse('2026-09-10T02:10:00Z')
const advice = {
  decisionSource: { engine: 'MULTI_TASK', state: 'READY' },
  stopPrice: 9,
  targetPrice: 12,
  decisionPlan: {
    action: 'BUY', actionability: 'READY',
    quantity: { lots: 2 }, prices: { reference: 10 },
    validUntil: '2026-09-10T03:30:00Z',
  },
}

test('执行卡片同时给出动作手数时点和参考价', () => {
  const view = decisionPresentation({ advice, now })
  assert.equal(view.headline, '买入 2 手')
  assert.equal(view.timing, '当前交易时段')
  assert.equal(view.reference, '10元')
  assert.equal(view.executable, true)
})

test('卡片价位带展示系统观察价、执行价、止损和目标', () => {
  const prices = decisionPrices({
    ...advice,
    pullbackWatchPrice: 9.8,
    breakoutWatchPrice: 10.4,
    decisionPlan: {
      ...advice.decisionPlan,
      prices: {
        reference: 10,
        stop: 9,
        target: 12,
        observations: [
          { key: 'watch_pullback', price: 9.75 },
          { key: 'watch_breakout', price: 10.45 },
        ],
      },
    },
  })

  assert.deepEqual(
    prices.map(({ key, label, value }) => ({ key, label, value })),
    [
      { key: 'watch_pullback', label: '回踩观察', value: 9.75 },
      { key: 'watch_breakout', label: '突破观察', value: 10.45 },
      { key: 'reference', label: '买入参考', value: 10 },
      { key: 'stop', label: '止损', value: 9 },
      { key: 'target', label: '目标', value: 12 },
    ],
  )
})

test('没有系统决策或无效价格时卡片价位带保持为空', () => {
  assert.deepEqual(decisionPrices({}), [])
  assert.deepEqual(decisionPrices({
    decisionSource: { engine: 'MULTI_TASK' },
    decisionPlan: {
      action: 'WATCH',
      prices: { reference: 10, stop: null, target: 0 },
    },
  }), [])
})

test('旧军师结果不冒充系统交易指令', () => {
  const view = decisionPresentation({
    advice: { ...advice, decisionSource: null }, now,
  })
  assert.equal(view.executable, false)
  assert.equal(view.headline, '暂不买入')
  assert.match(view.reason, /尚无本轮系统决策/)
})

test('过期和未就绪明确不执行而不是0%胜率', () => {
  const expired = decisionPresentation({
    advice, now: now + 86400000,
  })
  const unavailable = decisionPresentation({
    advice: { ...advice, decisionSource: { engine: 'MULTI_TASK', state: 'MODEL_NOT_READY' },
      decisionPlan: { ...advice.decisionPlan, action: 'WATCH', actionability: 'WATCH', quantity: { lots: 0 } },
    }, now,
  })
  assert.equal(expired.executable, false)
  assert.match(expired.reason, /过期/)
  assert.match(unavailable.reason, /本轮未获得有效决策模型结果/)
  assert.doesNotMatch(unavailable.reason, /0%/)
})

test('停止、价格偏离和已执行的指令不再显示记录买入主操作', () => {
  for (const extra of [
    { loading: true }, { managed: false }, { currentPrice: 10.5 },
    { executionPlans: [{ decisionId: 'v3-one', status: 'COMPLETED' }] },
  ]) {
    const view = decisionPresentation({
      advice: { ...advice, decisionPlan: { ...advice.decisionPlan, decisionId: 'v3-one' } },
      now, ...extra,
    })
    assert.equal(view.executable, false)
  }
})

test('卡片在没有系统决策或评估期间仍输出账本止损与可卖数量', () => {
  const view = decisionPresentation({
    holdingLots: 3, sellableLots: 2, stopPrice: 9.5, currentPrice: 9.4,
    loading: true, now,
  })
  assert.equal(view.headline, '减仓 2 手')
  assert.equal(view.actionable, true)
  assert.equal(view.hardStop, true)
  const locked = decisionPresentation({
    holdingLots: 3, sellableLots: 0, stopPrice: 9.5, currentPrice: 9.4, now,
  })
  assert.equal(locked.executable, false)
  assert.match(locked.reason, /T\+1/)
})

test('持仓加仓观察计划明确显示触发后由系统重评', () => {
  const view = decisionPresentation({
    advice: {
      ...advice,
      pullbackWatchPrice: 9.8,
      holdingAddPlan: {
        schemaVersion: 'holding-add-plan.v1',
        route: 'PULLBACK',
        price: 9.8,
      },
      decisionPlan: {
        ...advice.decisionPlan,
        action: 'HOLD',
        actionability: 'WATCH',
        quantity: { lots: 0 },
      },
    },
    holdingLots: 2,
    now,
  })

  assert.equal(view.headline, '继续持有 2 手')
  assert.equal(view.addWaiting, true)
  assert.match(view.reason, /回踩 9\.8元后由系统重新评估加仓/)
  assert.equal(view.timing, '加仓观察价触发后')
})

test('持仓加仓复核通过后显示核定加仓手数', () => {
  const view = decisionPresentation({
    advice: {
      ...advice,
      decisionPlan: {
        ...advice.decisionPlan,
        action: 'ADD',
        quantity: { lots: 1 },
      },
    },
    holdingLots: 2,
    now,
  })

  assert.equal(view.headline, '加仓 1 手')
  assert.equal(view.kind, 'add')
  assert.equal(view.executable, true)
})

test('旧版非止损清仓建议也先显示退出复核，复核终态后才可执行', () => {
  const exitAdvice = {
    decisionSource: {
      engine: 'MULTI_TASK',
      state: 'READY',
      hardProtection: false,
    },
    stopPrice: 48.85,
    decisionPlan: {
      decisionId: 'old-decision-exit',
      action: 'EXIT',
      actionability: 'READY',
      quantity: { lots: 1 },
      prices: { reference: 53.47 },
      validUntil: '2026-09-10T03:30:00Z',
    },
  }
  const pending = decisionPresentation({
    advice: exitAdvice,
    holdingLots: 1,
    sellableLots: 1,
    currentPrice: 53.9,
    now,
  })
  assert.equal(pending.executable, false)
  assert.equal(pending.headline, '等待退出前复核')
  assert.match(pending.reason, /约60秒/)

  const reviewed = decisionPresentation({
    advice: {
      ...exitAdvice,
      reviewDecision: { terminal: true, outcome: '清仓' },
    },
    holdingLots: 1,
    sellableLots: 1,
    currentPrice: 53.9,
    now,
  })
  assert.equal(reviewed.executable, true)
  assert.equal(reviewed.headline, '清仓 1 手')
})
