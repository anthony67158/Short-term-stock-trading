import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deepModelProgressMessage,
  ensureAdviceReasoning,
  splitAdviceReasoningSteps,
} from '../shared/adviceReasoning.js'

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

test('深度研判摘要覆盖不同证据维度且不保留重复占位文本', () => {
  const advice = ensureAdviceReasoning({
    action: '持有',
    title: '持有观察，暂不追高加仓',
    actionPlan: '放量站稳压力位后再复核加仓。',
    reasoning: '正在继续核验量价、资金、消息与风险约束…',
    quantNote: '次日上涨概率51%，预期收益接近零。',
    techNote: '均线多头，但RSI与KDJ处于高位。',
    fundNote: '主力净流入，小单净流出，需要量价确认。',
    newsNote: '消息仅为待核验线索，不能单独支持加仓。',
    bearCase: '指标过热且临近压力位，存在冲高回落风险。',
    invalidation: '跌破关键支撑后取消加仓并执行防守。',
  }, [
    '正在继续核验量价、资金、消息与风险约束…',
    '正在继续核验量价、资金、消息与风险约束…',
  ].join('\n'), {
    deepMode: true,
  })

  assert.match(advice.reasoning, /结论：/)
  assert.match(advice.reasoning, /量化：/)
  assert.match(advice.reasoning, /技术：/)
  assert.match(advice.reasoning, /资金：/)
  assert.match(advice.reasoning, /消息：/)
  assert.match(advice.reasoning, /风险：/)
  assert.equal(
    advice.reasoning.match(/正在继续核验/g)?.length || 0,
    0,
  )
  const lines = advice.reasoning.split('\n').filter(Boolean)
  assert.equal(new Set(lines).size, lines.length)
})

test('深度模型长时间无正文时持续给出有边界的真实等待状态', () => {
  assert.equal(deepModelProgressMessage(9000), '')
  assert.match(deepModelProgressMessage(10000), /已接收任务/)
  assert.match(deepModelProgressMessage(15000), /交叉核验/)
  assert.match(deepModelProgressMessage(30000), /收束唯一动作/)
  assert.match(deepModelProgressMessage(45000), /达到时限将自动结束/)
})

test('多维研判摘要按换行展示为独立步骤', () => {
  const steps = splitAdviceReasoningSteps([
    '结论：继续持有',
    '量化：次日方向震荡',
    '风险：跌破支撑退出',
  ].join('\n'))

  assert.deepEqual(steps.map((item) => item.body), [
    '结论：继续持有',
    '量化：次日方向震荡',
    '风险：跌破支撑退出',
  ])
  assert.deepEqual(steps.map((item) => item.mark), ['①', '②', '③'])
})
