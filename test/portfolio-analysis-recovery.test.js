import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generatePortfolioExplanation,
} from '../api/portfolio_analysis.js'

const context = {
  distribution: {
    positionPct: 28.5,
  },
  market: {
    regimeLabel: '震荡',
    score: 50,
    note: '市场分歧',
  },
  evidence: [{
    id: 'E1',
    title: 'V3持仓决策',
    summary: '当前没有新增动作',
  }],
}

const analysis = {
  executionPlan: {
    targetPositionPct: 28.5,
    projectedPositionPct: 28.5,
    projectedCashReservePct: 71.5,
    orders: [],
  },
  stockActions: [{
    code: '600000',
    name: '浦发银行',
    action: 'hold',
    reason: 'V3继续持有',
  }],
  risks: [],
}

function response(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {
        choices: [{
          message: { content },
        }],
      }
    },
  }
}

function chatResult(content, status = 200) {
  const calls = []
  let doneCalls = 0
  return {
    calls,
    doneCalls: () => doneCalls,
    chat: async (options) => {
      calls.push(options)
      return {
        resp: response(content, status),
        selectedModel: options.model,
        endpoint: 'explain-1',
        done() {
          doneCalls++
        },
      }
    },
  }
}

test('组合解释只调用一次explain且强制关闭深度思考', async () => {
  const stub = chatResult(JSON.stringify({
    summary: '当前维持原仓位。',
    counterCase: '市场可能继续转弱。',
    invalidation: 'V3决策或账户事实变化后重评。',
    evidenceGap: '无',
  }))
  const result = await generatePortfolioExplanation(
    context,
    structuredClone(analysis),
    {
      model: 'explain-model',
      decisionId: 'portfolio.test',
      chat: stub.chat,
      now: 1,
    },
  )

  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].role, 'explain')
  assert.equal(stub.calls[0].forceNoReason, true)
  assert.equal(stub.calls[0].maxTokens, 900)
  assert.equal(result.explanation.status, 'ready')
  assert.equal(result.explanation.decisionId, 'portfolio.test')
  assert.equal(stub.doneCalls(), 1)
})

test('组合解释越权输出动作字段时拒绝且不修改V3执行单', async () => {
  const source = structuredClone(analysis)
  const stub = chatResult(JSON.stringify({
    summary: '当前维持原仓位。',
    counterCase: '市场可能继续转弱。',
    invalidation: 'V3决策或账户事实变化后重评。',
    evidenceGap: '无',
    action: 'SELL',
  }))
  const result = await generatePortfolioExplanation(
    context,
    source,
    {
      model: 'explain-model',
      decisionId: 'portfolio.test',
      chat: stub.chat,
    },
  )

  assert.equal(result.explanation, null)
  assert.match(result.error, /越权字段/)
  assert.deepEqual(source, analysis)
  assert.equal(stub.calls.length, 1)
})

test('解释端点失败不影响既有V3组合结果', async () => {
  const source = structuredClone(analysis)
  const stub = chatResult('', 503)
  const result = await generatePortfolioExplanation(
    context,
    source,
    {
      model: 'explain-model',
      decisionId: 'portfolio.test',
      chat: stub.chat,
    },
  )

  assert.equal(result.explanation, null)
  assert.match(result.error, /暂不可用/)
  assert.deepEqual(source, analysis)
  assert.equal(stub.calls.length, 1)
})
