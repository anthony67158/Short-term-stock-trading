import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectOutcomeSnapshots,
  duplicateSmartAlerts,
  directionalOutcome,
  fuseConfirmation,
  judgeEffectStats,
  resolveImmediateConfirmationAlert,
  resolveDecisionSide,
  shouldCallLlmJudge,
  shouldConfirmImmediatelyAfterTouch,
  shouldRequestConfirmation,
} from '../shared/confirmPolicy.js'

const det = (score, decision = 'wait') => ({ score, decision, hits: [] })
const llm = (decision, confidence) => ({ decision, confidence, reason: '模型判断' })

test('买入必须同时通过客观信号和高置信 LLM，不允许模型单独确认', () => {
  const result = fuseConfirmation({
    side: 'buy',
    deterministic: det(1.5),
    llm: llm('confirm', 92),
    observationAgeMs: 5 * 60 * 1000,
  })

  assert.equal(result.decision, 'wait')
  assert.equal(result.gated, true)
  assert.match(result.reason, /客观信号/)
})

test('买入客观信号充分且 LLM 高置信时确认', () => {
  const result = fuseConfirmation({
    side: 'buy',
    deterministic: det(3, 'confirm'),
    llm: llm('confirm', 82),
    observationAgeMs: 5 * 60 * 1000,
  })

  assert.equal(result.decision, 'confirm')
  assert.equal(result.policy, 'consensus')
})

test('止盈确认阈值低于买入以避免利润明显回撤', () => {
  const result = fuseConfirmation({
    side: 'sell',
    deterministic: det(2, 'confirm'),
    llm: llm('confirm', 72),
    observationAgeMs: 2 * 60 * 1000,
  })

  assert.equal(result.decision, 'confirm')
})

test('止损出现强客观破位时可覆盖 LLM 犹豫', () => {
  const result = fuseConfirmation({
    side: 'stop',
    deterministic: det(3, 'confirm'),
    llm: llm('wait', 80),
    observationAgeMs: 3 * 60 * 1000,
  })

  assert.equal(result.decision, 'confirm')
  assert.equal(result.policy, 'risk-override')
})

test('灾难性止损不等待观察窗口或LLM确认', () => {
  const result = fuseConfirmation({
    side: 'stop',
    deterministic: det(3.5, 'confirm'),
    llm: null,
    observationAgeMs: 5000,
  })

  assert.equal(result.decision, 'confirm')
  assert.equal(result.policy, 'risk-override')
})

test('前端止损触价后立即请求后端以允许强破位快通道', () => {
  const now = Date.now()

  assert.equal(shouldRequestConfirmation('stop', now - 5000, now), true)
  assert.equal(shouldRequestConfirmation('buy', now - 5000, now), false)
  assert.equal(
    shouldRequestConfirmation('buy', now - 2 * 60 * 1000, now),
    true,
  )
})

test('只有止损在首次触价落盘后立即进入确认', () => {
  assert.equal(shouldConfirmImmediatelyAfterTouch('stop'), true)
  assert.equal(shouldConfirmImmediatelyAfterTouch('sell'), false)
  assert.equal(shouldConfirmImmediatelyAfterTouch('buy'), false)
})

test('止损即时确认必须等待权威状态落盘并重读watching预警', async () => {
  const events = []
  const current = {
    id: 'stop-1',
    enabled: true,
    phase: 'watching',
  }
  const resolved = await resolveImmediateConfirmationAlert({
    side: 'stop',
    alertId: 'stop-1',
    flushSave: async () => {
      events.push('saved')
      return true
    },
    getAlerts: () => {
      events.push('read')
      return [current]
    },
  })

  assert.deepEqual(events, ['saved', 'read'])
  assert.equal(resolved, current)
  assert.equal(await resolveImmediateConfirmationAlert({
    side: 'buy',
    alertId: 'stop-1',
    flushSave: async () => {
      throw new Error('买入不应立即落盘确认')
    },
    getAlerts: () => [current],
  }), null)
})

test('确定性信号未达到确认门槛时不调用LLM', () => {
  assert.equal(
    shouldCallLlmJudge('buy', { decision: 'wait', score: 2 }),
    false,
  )
  assert.equal(
    shouldCallLlmJudge('buy', { decision: 'confirm', score: 2.5 }),
    true,
  )
})

test('LLM 未提供置信度时不能发买卖强提示', () => {
  const result = fuseConfirmation({
    side: 'buy',
    deterministic: det(3, 'confirm'),
    llm: llm('confirm', null),
    observationAgeMs: 5 * 60 * 1000,
  })

  assert.equal(result.decision, 'wait')
  assert.match(result.reason, /置信度/)
})

test('刚触价时先观察，不能拿触价前分时立即确认', () => {
  const result = fuseConfirmation({
    side: 'sell',
    deterministic: det(3, 'confirm'),
    llm: llm('confirm', 90),
    observationAgeMs: 20 * 1000,
  })

  assert.equal(result.decision, 'wait')
  assert.match(result.reason, /观察/)
})

test('LLM 判失效必须得到客观失效信号支持', () => {
  const unsupported = fuseConfirmation({
    side: 'buy',
    deterministic: det(1),
    llm: llm('invalid', 90),
    observationAgeMs: 5 * 60 * 1000,
  })
  const supported = fuseConfirmation({
    side: 'buy',
    deterministic: det(3, 'invalid'),
    llm: llm('invalid', 85),
    observationAgeMs: 5 * 60 * 1000,
  })

  assert.equal(unsupported.decision, 'wait')
  assert.equal(supported.decision, 'invalid')
})

test('后验收益按买入看涨、卖出和止损看跌统一成正数为正确', () => {
  assert.equal(directionalOutcome('buy', 10, 10.5), 5)
  assert.equal(directionalOutcome('sell', 10, 9.5), 5)
  assert.equal(directionalOutcome('stop', 10, 9), 10)
})

test('强提示后按5/15/30分钟记录方向收益用于评估Judge效果', () => {
  const alert = {
    phase: 'confirmed',
    triggeredAt: 1000,
    decisionPrice: 10,
    decisionSide: 'sell',
    judgeOutcomes: {},
  }
  const first = collectOutcomeSnapshots(alert, 9.8, 1000 + 6 * 60 * 1000)
  const second = collectOutcomeSnapshots(
    { ...alert, judgeOutcomes: first.outcomes },
    9.5,
    1000 + 31 * 60 * 1000,
  )

  assert.equal(first.changed, true)
  assert.equal(first.outcomes.m5.directionalPct, 2)
  assert.equal(second.outcomes.m15.directionalPct, 5)
  assert.equal(second.outcomes.m30.directionalPct, 5)
})

test('同股同方向同价位的智能预警只保留信息更完整的一条', () => {
  const alerts = [
    { id: 'plain', code: '600000', type: 'price', phase: 'armed', enabled: true, op: 'gte', value: 10, note: '止盈' },
    { id: 'detail', code: '600000', type: 'price', phase: 'armed', enabled: true, op: 'gte', value: 10, note: '减仓点', actKind: 'reduce', timing: '冲高回落再减' },
  ]
  const result = duplicateSmartAlerts(alerts, () => 'sell')

  assert.deepEqual(result, [{ id: 'plain', primaryId: 'detail' }])
})

test('Judge效果统计优先使用30分钟后验并计算方向命中率', () => {
  const stats = judgeEffectStats([
    { id: 'buy-1', phase: 'confirmed', decisionSide: 'buy', judgeOutcomes: { m30: { directionalPct: 2 } } },
    { id: 'sell-1', phase: 'confirmed', decisionSide: 'sell', judgeOutcomes: { m15: { directionalPct: -1 } } },
    { id: 'stop-1', phase: 'confirmed', decisionSide: 'stop', judgeOutcomes: {} },
    { kind: 'judge', alertId: 'archived', decisionSide: 'buy', judgeOutcomes: { m30: { directionalPct: 3 } } },
    { id: 'archived', phase: 'confirmed', decisionSide: 'buy', judgeOutcomes: { m5: { directionalPct: 1 } } },
  ])

  assert.equal(stats.confirmed, 4)
  assert.equal(stats.evaluated, 3)
  assert.equal(stats.wins, 2)
  assert.equal(stats.winRate, 67)
  assert.equal(stats.avgDirectionalPct, 1.33)
})

test('Judge确认方向优先使用本次判定并回退预警客观方向', () => {
  assert.equal(resolveDecisionSide({ side: 'sell' }, 'buy'), 'sell')
  assert.equal(resolveDecisionSide({}, 'stop'), 'stop')
  assert.equal(resolveDecisionSide({ side: 'unknown' }, 'buy'), 'buy')
})
