import test from 'node:test'
import assert from 'node:assert/strict'

import { createAdviceSSEParser, progressPatchForEvent } from '../api/cron_advice.js'
import { resolveAIBudget } from '../api/ai.js'

test('服务端可解析跨分片的 AI SSE 事件', () => {
  const seen = []
  const parser = createAdviceSSEParser((event, data) => seen.push({ event, data }))

  parser.push('event: phase\ndata: {"text":"正在采集')
  parser.push('行情"}\n\nevent: reasoning\ndata: {"text":"正在判断支撑位。"}\n\n')
  parser.end()

  assert.deepEqual(seen, [
    { event: 'phase', data: { text: '正在采集行情' } },
    { event: 'reasoning', data: { text: '正在判断支撑位。' } },
  ])
})

test('AI SSE 事件会转换为持久任务进度补丁', () => {
  assert.deepEqual(
    progressPatchForEvent('phase', { text: '正在量化打分' }),
    { phase: '正在量化打分' },
  )
  assert.deepEqual(
    progressPatchForEvent('source', { label: '实时行情', ok: true }),
    { source: { label: '实时行情', ok: true } },
  )
  assert.deepEqual(
    progressPatchForEvent('reasoning', { text: '正在检查量价共振。' }),
    { reasoningDelta: '正在检查量价共振。' },
  )
  assert.deepEqual(
    progressPatchForEvent('model', { model: 'DeepSeek-V4-Pro', endpoint: '主端点' }),
    { model: 'DeepSeek-V4-Pro', endpoint: '主端点' },
  )
})

test('批量任务可收紧单股预算但不能突破安全边界', () => {
  assert.equal(resolveAIBudget(true, 210000), 210000)
  assert.equal(resolveAIBudget(true, 999999), 560000)
  assert.equal(resolveAIBudget(true, 1000), 30000)
  assert.equal(resolveAIBudget(false, null), 150000)
})
