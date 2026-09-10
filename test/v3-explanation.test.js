import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildV3ExplanationPacket,
  cachedV3Explanation,
  currentV3Advice,
  normalizeV3Explanation,
} from '../shared/v3Explanation.js'
import {
  mutateExplanation,
} from '../api/v3_explain.js'

const decisionPlan = {
  decisionId: 'decision.v3',
  action: 'BUY',
  actionability: 'READY',
  quantity: { lots: 2 },
  prices: { reference: 10, stop: 9, target: 12 },
  blockedReasons: [],
}

const advice = {
  decisionSource: {
    engine: 'V3',
    modelVersion: 'opportunity-score.direct',
  },
  decisionPlan,
  selectedV3Plan: {
    opportunityScore: {
      pFill: 0.7,
      pWinGivenFill: 0.6,
      expectedNetR: 0.2,
      netRLowerBound: -0.3,
      expectedShortfall10: -1.2,
    },
  },
  actionPlan: '买入2手',
  invalidation: '跌破9元后重新评估',
}

test('解释包只投影V3已核定事实', () => {
  const packet = buildV3ExplanationPacket(advice)
  assert.deepEqual(packet.prices, {
    reference: 10,
    stop: 9,
    target: 12,
  })
  assert.equal(packet.quantityLots, 2)
  assert.equal(packet.model.expectedNetR, 0.2)
  assert.equal(packet.account, undefined)
})

test('解释输出拒绝动作价格手数等越权字段', () => {
  const valid = {
    summary: '按当前计划执行。',
    counterCase: '资金可能转弱。',
    invalidation: '触发既定失效条件时重评。',
    evidenceGap: '无',
  }
  assert.equal(normalizeV3Explanation(valid, {
    decisionId: 'decision.v3',
    model: 'explain-model',
    now: 1,
  }).status, 'ready')
  assert.throws(() => normalizeV3Explanation({
    ...valid,
    action: 'SELL',
  }, { decisionId: 'decision.v3' }), /越权字段/)
})

test('缓存和权威建议必须绑定当前decisionId', () => {
  const account = {
    advice: {
      '600001': {
        advice: {
          ...advice,
          v3Explanation: {
            schemaVersion: 'v3-explanation.v1',
            status: 'ready',
            decisionId: 'decision.v3',
          },
        },
      },
    },
  }
  const current = currentV3Advice(account, '600001', 'decision.v3')
  assert.ok(current)
  assert.equal(
    cachedV3Explanation(current.advice, 'decision.v3')?.status,
    'ready',
  )
  assert.equal(currentV3Advice(account, '600001', 'stale'), null)
})

test('解释接口只读取权威账号且不改写决策字段', () => {
  const source = readFileSync(
    new URL('../api/v3_explain.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /authorizePaidRequest\(req\)/)
  assert.match(source, /currentV3Advice/)
  assert.match(source, /role:\s*'explain'/)
  assert.match(source, /forceNoReason:\s*true/)
  assert.doesNotMatch(source, /decisionPlan\s*=/)
})

test('解释保存冲突会重读权威建议且只追加解释字段', async () => {
  const base = {
    nick: 'fixture',
    data: {
      advice: {
        '600001': {
          mode: 'buy_advice',
          updatedAt: 1,
          advice: structuredClone(advice),
        },
      },
    },
  }
  const originalPlan = structuredClone(decisionPlan)
  let reads = 0
  let writes = 0
  let saved = null
  const explanation = {
    schemaVersion: 'v3-explanation.v1',
    status: 'ready',
    decisionId: 'decision.v3',
    summary: '当前计划解释',
    counterCase: '最强反方',
    invalidation: '失效条件',
    evidenceGap: '无',
  }

  const result = await mutateExplanation(
    'fixture',
    '600001',
    'decision.v3',
    () => explanation,
    {
      readAccountFn: async () => {
        reads++
        return structuredClone(base)
      },
      writeAccountFn: async (account) => {
        writes++
        if (writes === 1) {
          const error = new Error('conflict')
          error.status = 409
          throw error
        }
        saved = structuredClone(account)
      },
    },
  )

  assert.equal(reads, 2)
  assert.equal(writes, 2)
  assert.deepEqual(result, explanation)
  assert.deepEqual(
    saved.data.advice['600001'].advice.decisionPlan,
    originalPlan,
  )
  assert.deepEqual(
    saved.data.advice['600001'].advice.v3Explanation,
    explanation,
  )
})
