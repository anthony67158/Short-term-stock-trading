import test from 'node:test'
import assert from 'node:assert/strict'
import { v3DecisionPresentation } from '../shared/v3DecisionPresentation.js'

const now = Date.parse('2026-09-10T02:10:00Z')
const advice = {
  decisionSource: { engine: 'V3', state: 'READY' },
  stopPrice: 9,
  targetPrice: 12,
  decisionPlan: {
    action: 'BUY', actionability: 'READY',
    quantity: { lots: 2 }, prices: { reference: 10 },
    validUntil: '2026-09-10T03:30:00Z',
  },
}

test('执行卡片同时给出动作手数时点和参考价', () => {
  const view = v3DecisionPresentation({ advice, now })
  assert.equal(view.headline, '买入 2 手')
  assert.equal(view.timing, '当前交易时段')
  assert.equal(view.reference, '10元')
  assert.equal(view.executable, true)
})

test('旧军师结果不冒充V3交易指令', () => {
  const view = v3DecisionPresentation({
    advice: { ...advice, decisionSource: null }, now,
  })
  assert.equal(view.executable, false)
  assert.equal(view.headline, '暂不买入')
  assert.match(view.reason, /尚无本轮V3/)
})

test('过期和未就绪明确不执行而不是0%胜率', () => {
  const expired = v3DecisionPresentation({
    advice, now: now + 86400000,
  })
  const unavailable = v3DecisionPresentation({
    advice: { ...advice, decisionSource: { engine: 'V3', state: 'MODEL_NOT_READY' },
      decisionPlan: { ...advice.decisionPlan, action: 'WATCH', actionability: 'WATCH', quantity: { lots: 0 } },
    }, now,
  })
  assert.equal(expired.executable, false)
  assert.match(expired.reason, /过期/)
  assert.match(unavailable.reason, /本轮未获得有效V3结果/)
  assert.doesNotMatch(unavailable.reason, /0%/)
})

test('停止、价格偏离和已执行的指令不再显示记录买入主操作', () => {
  for (const extra of [
    { loading: true }, { managed: false }, { currentPrice: 10.5 },
    { executionPlans: [{ decisionId: 'v3-one', status: 'COMPLETED' }] },
  ]) {
    const view = v3DecisionPresentation({
      advice: { ...advice, decisionPlan: { ...advice.decisionPlan, decisionId: 'v3-one' } },
      now, ...extra,
    })
    assert.equal(view.executable, false)
  }
})

test('卡片在没有V3或评估期间仍输出账本止损与可卖数量', () => {
  const view = v3DecisionPresentation({
    holdingLots: 3, sellableLots: 2, stopPrice: 9.5, currentPrice: 9.4,
    loading: true, now,
  })
  assert.equal(view.headline, '减仓 2 手')
  assert.equal(view.actionable, true)
  assert.equal(view.hardStop, true)
  const locked = v3DecisionPresentation({
    holdingLots: 3, sellableLots: 0, stopPrice: 9.5, currentPrice: 9.4, now,
  })
  assert.equal(locked.executable, false)
  assert.match(locked.reason, /T\+1/)
})

test('旧版非止损清仓建议也先显示退出复核，复核终态后才可执行', () => {
  const exitAdvice = {
    decisionSource: {
      engine: 'V3',
      state: 'READY',
      hardProtection: false,
    },
    stopPrice: 48.85,
    decisionPlan: {
      decisionId: 'old-v3-exit',
      action: 'EXIT',
      actionability: 'READY',
      quantity: { lots: 1 },
      prices: { reference: 53.47 },
      validUntil: '2026-09-10T03:30:00Z',
    },
  }
  const pending = v3DecisionPresentation({
    advice: exitAdvice,
    holdingLots: 1,
    sellableLots: 1,
    currentPrice: 53.9,
    now,
  })
  assert.equal(pending.executable, false)
  assert.equal(pending.headline, '等待退出前复核')
  assert.match(pending.reason, /约60秒/)

  const reviewed = v3DecisionPresentation({
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
