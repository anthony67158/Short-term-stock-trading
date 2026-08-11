import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureAdviceReasoning } from '../shared/adviceReasoning.js'

test('优先保留模型返回的结构化研判思路', () => {
  const advice = ensureAdviceReasoning({
    reasoning: '先看资金流，再按支撑位确定动作。',
    reason: '备用理由',
  }, '流式思考')
  assert.equal(advice.reasoning, '先看资金流，再按支撑位确定动作。')
})

test('批量快速模式缺失思考链时使用可追溯依据补齐', () => {
  const advice = ensureAdviceReasoning({
    actionPlan: '回踩10元企稳再买1手',
    quantNote: '量化方向偏多，但把握闸未完全通过',
    techNote: '10元附近是20日线支撑',
  }, '')

  assert.match(advice.reasoning, /量化方向偏多/)
  assert.match(advice.reasoning, /20日线支撑/)
  assert.match(advice.reasoning, /回踩10元/)
})

test('持久任务流式中文推理可回填最终建议', () => {
  const advice = ensureAdviceReasoning(
    { action: '持有' },
    '正在核对资金连续性。\n正在计算止损空间。',
  )
  assert.match(advice.reasoning, /资金连续性/)
  assert.match(advice.reasoning, /止损空间/)
})
