import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildV3ExplanationPacket,
  cachedV3Explanation,
  currentV3Advice,
  normalizeV3Explanation,
  V3_EXPLANATION_SCHEMA_VERSION,
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
  decisionEvidence: {
    schemaVersion: 'v3-decision-evidence.v1',
    asOf: 1,
    availability: {
      dailyTechnical: true,
      intradayTechnical: true,
      currentFund: true,
      fundHistory: true,
      completeFundHistory: true,
      sectorContext: true,
      marketBreadth: true,
    },
    technical: {
      quotePct: 2.1,
      ret5dPct: 4.2,
      atrPct: 1.3,
      vwapDistancePct: 0.4,
    },
    funds: {
      asOfDate: '2026-09-10',
      mainNetYi: 1.2,
      retailNetYi: -0.5,
      historyDayCount: 5,
      historyComplete: true,
      mainTrend5: [0.2, 0.4, 0.6, 0.8, 1.2],
      retailTrend5: [-0.1, -0.2, -0.3, -0.4, -0.5],
      main5dYi: 3.2,
      retail5dYi: -1.5,
      mainInflowDays5: 5,
      retailInflowDays5: 0,
      mainStreak5: 5,
      retailStreak5: -5,
    },
    sector: {
      matched: true,
      code: 'BK1000',
      name: '测试板块',
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      rank: 2,
      mainNetYi: 3.1,
      breadthPct: 65,
    },
    market: { up: 3000, down: 1500, flat: 100 },
    knownGaps: [],
  },
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
  assert.equal(packet.facts.evidence.funds.historyDayCount, 5)
  assert.equal(packet.facts.evidence.sector.name, '测试板块')
  assert.equal(packet.facts.evidence.technical.ret5dPct, 4.2)
  assert.deepEqual(packet.facts.knownGaps, [])
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
    evidenceGaps: [],
  }).status, 'ready')
  assert.equal(normalizeV3Explanation({
    ...valid,
    evidenceGap: '缺少基本面和做空力量',
  }, {
    decisionId: 'decision.v3',
    model: 'explain-model',
    now: 1,
    evidenceGaps: ['资金逐日历史仅1个交易日'],
  }).evidenceGap, '资金逐日历史仅1个交易日')
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
            schemaVersion: V3_EXPLANATION_SCHEMA_VERSION,
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
  assert.match(source, /evidenceGap只能逐项复述facts\.knownGaps/)
  assert.match(source, /evidenceGaps:\s*packet\.facts\.knownGaps/)
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
    schemaVersion: V3_EXPLANATION_SCHEMA_VERSION,
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
