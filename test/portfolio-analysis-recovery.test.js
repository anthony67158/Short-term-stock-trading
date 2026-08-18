import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateAnalysis,
} from '../api/portfolio_analysis.js'

const context = {
  distribution: {
    positionPct: 28.5,
    cashReservePct: 71.5,
    categories: [],
    groups: [],
    stocks: [],
  },
  market: {
    regime: 'balanced',
    score: 50,
  },
  activeConcepts: [],
  quantRows: [],
  candidateRows: [],
  evidence: [],
}

function response({
  status = 200,
  content = '',
  reasoning = '',
  finishReason = 'stop',
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {
        choices: [{
          finish_reason: finishReason,
          message: {
            content,
            reasoning_content: reasoning,
          },
        }],
      }
    },
  }
}

function chatSequence(steps) {
  const calls = []
  const chat = async (options) => {
    calls.push(options)
    const step = steps.shift()
    return {
      resp: step instanceof Error
        ? { __err: step }
        : response(step),
      selectedModel: options.model,
      endpoint: options.role === 'advisor'
        ? 'advisor-backup'
        : 'portfolio-main',
      done() {},
    }
  }
  return { chat, calls }
}

test('持仓专用模型404时自动切换可用军师模型完成结论', async () => {
  const { chat, calls } = chatSequence([
    { status: 404 },
    { content: '{"headline":"已恢复完整结论"}' },
  ])

  const result = await generateAnalysis(context, {
    model: 'missing-portfolio-model',
    fallbackModel: 'advisor-model',
    deepMode: true,
    functionMessages: [],
    chat,
  })

  assert.equal(result.raw.headline, '已恢复完整结论')
  assert.equal(result.recovered, true)
  assert.equal(result.failureCode, 'http_404')
  assert.equal(result.model, 'advisor-model')
  assert.equal(result.endpoint, 'advisor-backup')
  assert.match(result.warning, /自动切换/)
  assert.deepEqual(calls.map((call) => call.role), [
    'portfolio',
    'advisor',
  ])
  assert.equal(calls[1].forceNoReason, true)
})

test('深度模型只有思考没有正文时先关闭思考重试同一模型', async () => {
  const { chat, calls } = chatSequence([
    {
      content: '',
      reasoning: '这里有很长的推理但没有最终JSON',
      finishReason: 'length',
    },
    { content: '{"headline":"无思考重试成功"}' },
  ])

  const result = await generateAnalysis(context, {
    model: 'portfolio-model',
    fallbackModel: 'advisor-model',
    deepMode: true,
    functionMessages: [],
    chat,
  })

  assert.equal(result.raw.headline, '无思考重试成功')
  assert.equal(result.recovered, true)
  assert.equal(result.failureCode, 'empty_content')
  assert.deepEqual(calls.map((call) => call.role), [
    'portfolio',
    'portfolio',
  ])
  assert.equal(calls[0].forceReason, true)
  assert.equal(calls[1].forceNoReason, true)
})

test('专用模型与备用模型都失败时保留可定位的安全失败原因', async () => {
  const timeout = new Error('aborted')
  timeout.name = 'AbortError'
  const { chat, calls } = chatSequence([
    { status: 404 },
    timeout,
  ])

  const result = await generateAnalysis(context, {
    model: 'missing-portfolio-model',
    fallbackModel: 'advisor-model',
    deepMode: false,
    functionMessages: [],
    chat,
  })

  assert.equal(result.raw, null)
  assert.equal(result.failureCode, 'http_404')
  assert.equal(result.recoveryFailureCode, 'timeout')
  assert.match(result.error, /模型不存在或无权限/)
  assert.match(result.error, /备用模型/)
  assert.equal(calls.length, 2)
})
