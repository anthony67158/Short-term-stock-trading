import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAdvisorModelOutput } from '../api/_advice_output.js'
import { pumpChatStream } from '../api/_llm.js'
import { acceptsGenerationResult } from '../shared/adviceBatchPolicy.js'

const advice = {
  action: '持有', title: '继续持有1手', actionPlan: '跌破54元清仓1手',
  invalidation: '价格跌破54元', quantNote: '量化中性', fundNote: '主力净流出',
  nextOpenPlan: '开盘核对54元', futurePlan: '第5个交易日退出',
}
test('上游最终SSE帧没有换行也必须交付完整正文', async () => {
  const content = JSON.stringify(advice)
  const wire = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}`
  const result = await pumpChatStream(new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } }))
  assert.equal(result.content, content)
  assert.equal(result.finishReason, 'stop')
})

test('只缺闭括号但字段完整的输出可发布且不再被截断标记拒绝', () => {
  const result = parseAdvisorModelOutput({ content: JSON.stringify(advice).slice(0, -1), mode: 'hold_advice' })
  assert.equal(result.complete, true)
  assert.equal(result.closingDelimitersRecovered, true)
  assert.equal(acceptsGenerationResult({ advice: result.value, truncated: !result.complete }, 'hold_advice'), true)
})

test('字符串真正中断或缺少退出计划时绝不伪造完整结果', () => {
  const cut = JSON.stringify(advice).slice(0, -4)
  assert.equal(parseAdvisorModelOutput({ content: cut, mode: 'hold_advice' }).complete, false)
  const { futurePlan, ...missing } = advice
  const result = parseAdvisorModelOutput({ content: JSON.stringify(missing), mode: 'hold_advice' })
  assert.equal(result.complete, false)
  assert.ok(result.missing.includes('五日内退出路径'))
})

test('正文残缺但兼容网关另一通道有完整业务对象时采用完整对象', () => {
  const result = parseAdvisorModelOutput({
    content: '{"action":"持有"}',
    reasoning: `已结束说明\n${JSON.stringify(advice)}`,
    mode: 'hold_advice',
  })
  assert.equal(result.complete, true)
  assert.equal(result.source, 'reasoning')
  assert.deepEqual(result.value, advice)
})
