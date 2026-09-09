import test from 'node:test'
import assert from 'node:assert/strict'

import { readAIResultStream } from '../src/aiStream.js'

test('收到 result 终态后不等待 SSE EOF 或后续心跳', async () => {
  let reads = 0
  let canceled = false
  const body = {
    getReader() {
      return {
        async read() {
          reads++
          if (reads === 1) {
            return {
              done: false,
              value: new TextEncoder().encode(
                'event: result\ndata: {"ok":true,"result":{"action":"观望"}}\n\n',
              ),
            }
          }
          await new Promise(() => {})
        },
        async cancel() { canceled = true },
        releaseLock() {},
      }
    },
  }

  const result = await Promise.race([
    readAIResultStream(body),
    new Promise((_, reject) => setTimeout(() => reject(new Error('等待 EOF')), 100)),
  ])

  assert.equal(result.ok, true)
  assert.equal(result.result.action, '观望')
  assert.equal(reads, 1)
  // 终态交付后清理读取器是 fire-and-forget，不应阻塞返回。
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(canceled, true)
})

test('SSE 帧跨网络分片时仍保留完整模型结果', async () => {
  const chunks = [
    'event: phase\ndata: {"key":"llm"}\n\n',
    'event: result\ndata: {"ok":true,"result":{"action":"持有","actionPlan":"继续观察"}}\n\n',
  ]
  let index = 0
  const phases = []
  const body = {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: new TextEncoder().encode(chunks[index++]) }
        },
        async cancel() {},
        releaseLock() {},
      }
    },
  }
  const result = await readAIResultStream(body, {
    onPhase: (phase) => phases.push(phase),
  })
  assert.deepEqual(phases, [{ key: 'llm' }])
  assert.equal(result.result.actionPlan, '继续观察')
})
