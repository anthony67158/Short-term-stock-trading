import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCouncilContext,
  runAdvisorCouncilShadow,
} from '../api/_advisor_council.js'

test('委员会上下文只保留决策所需字段并限制外部文本长度', () => {
  const context = buildCouncilContext({
    code: '600001',
    name: '样本股份',
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      reason: 'A'.repeat(1000),
      buyPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11,
      planQty: 2,
    },
    payload: {
      account: { cash: 10000, totalAssets: 50000 },
      newsHeadlines: Array.from({ length: 20 }, (_, index) => `新闻${index}`),
      irrelevant: '不得进入上下文',
    },
  })

  assert.equal(context.code, '600001')
  assert.equal(context.advice.reason.length, 400)
  assert.equal(context.newsHeadlines.length, 6)
  assert.equal(context.irrelevant, undefined)
})

test('三个角色并行完成后生成不可执行的委员会影子记录', async () => {
  const called = []
  const result = await runAdvisorCouncilShadow({
    code: '600001',
    name: '样本股份',
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11,
      planQty: 2,
    },
    payload: {
      account: {
        cash: 10000,
        totalAssets: 50000,
        holdQty: 0,
      },
    },
    strategyGate: { productionEligible: false },
    evidenceSnapshotId: 'ev_test',
  }, {
    callOpinion: async (role) => {
      called.push(role)
      return {
        verdict: role === 'skeptic' ? 'oppose' : 'support',
        confidence: 70,
        thesis: `${role}观点`,
        veto: false,
      }
    },
    now: 123,
  })

  assert.deepEqual(called.sort(), [
    'researcher',
    'risk_officer',
    'skeptic',
  ])
  assert.equal(result.at, 123)
  assert.equal(result.shadowOnly, true)
  assert.equal(result.actionable, false)
  assert.equal(result.opinions.length, 3)
  assert.equal(result.compiled.consensusReached, true)
  assert.equal(result.compiled.hardGatePassed, false)
})

test('单角色超时不会阻断主流程但委员会必须保守失败', async () => {
  const result = await runAdvisorCouncilShadow({
    code: '600001',
    mode: 'buy_advice',
    advice: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11,
      planQty: 1,
    },
    payload: { account: { cash: 5000, totalAssets: 10000 } },
    strategyGate: { productionEligible: false },
    evidenceSnapshotId: 'ev_test',
  }, {
    callOpinion: async (role) => {
      if (role === 'risk_officer') throw new Error('timeout')
      return {
        verdict: 'support',
        confidence: 70,
        thesis: '支持',
      }
    },
  })

  assert.equal(result.opinions.length, 2)
  assert.equal(result.compiled.hardGatePassed, false)
  assert.ok(result.compiled.blockers.includes('缺少risk_officer意见'))
})
