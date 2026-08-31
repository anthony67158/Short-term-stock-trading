import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  explicitActionInstruction,
  explicitActionLabel,
  humanizeAdviceTextFields,
  humanizeUserFacingText,
} from '../shared/userFacingLanguage.js'
import { buildAdvicePresentation } from '../shared/advicePresentation.js'

const INTERNAL_TERMS = [
  'productionEligible',
  'strategyRoute',
  'marketEnv.regime',
  'RISK_OFF',
  'SHADOW_ONLY',
  'RESEARCH_ONLY',
  'specVersion',
  'blockerCodes',
  'TRIGGERED_REVIEW_REUSE_PREVIOUS',
]

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('旧建议中的策略内部字段改写为当前证据条件', () => {
  const result = humanizeUserFacingText(
    '策略闸门productionEligible为真、策略路线进入生产可执行，且marketEnv.regime不再为RISK_OFF时，观望失效。',
  )

  assert.equal(
    result,
    '历史限制已取消；市场结束防守状态且量价、资金与风险条件确认后，重新评估是否买入。',
  )
  for (const term of INTERNAL_TERMS) {
    assert.equal(result.includes(term), false)
  }
})

test('通用术语转换保留价格、T+1和常用技术指标', () => {
  const result = humanizeUserFacingText(
    'strategyRoute为SHADOW_ONLY，actionability=BLOCKED，specVersion不一致；跌破10.20元且RSI转弱时按T+1处理。',
  )

  assert.match(result, /历史限制已取消/)
  assert.match(result, /暂不可执行/)
  assert.match(result, /历史规则版本/)
  assert.match(result, /10\.20元/)
  assert.match(result, /RSI/)
  assert.match(result, /T\+1/)
})

test('到价复核复用上一轮量化时不暴露内部状态码', () => {
  const result = humanizeUserFacingText(
    '依赖条件未满足，本轮未执行（TRIGGERED_REVIEW_REUSE_PREVIOUS）',
  )

  assert.equal(
    result,
    '原建议没有可复用的量化结果，本轮快速复核不重复计算',
  )
  assert.doesNotMatch(result, /TRIGGERED_REVIEW/)
})

test('历史建议不把未来是否站回均价写成确定事实', () => {
  const result = humanizeUserFacingText(
    '回踩后不能重新站回66.59元均价，则取消本次关注；不因价格靠近而追买。',
  )

  assert.doesNotMatch(result, /不能重新站回|不会重新站回/)
  assert.match(result, /到价复核时尚未确认价格已重新站回66\.59元/)
  assert.match(result, /之后重新站回.*作为新事件重新评估/)

  const conditional = humanizeUserFacingText(
    '若下午有效跌破357.3元且不能重新站回，原计划失效。',
  )
  assert.doesNotMatch(conditional, /不能重新站回/)
  assert.match(conditional, /截至复核时仍未站回/)
})

test('操作标签明确区分当前仓位与本轮动作', () => {
  assert.equal(
    explicitActionLabel('持有', { holdingMode: true }),
    '继续持有',
  )
  assert.equal(
    explicitActionLabel('维持持有', {
      holdingMode: true,
      terminal: true,
    }),
    '本次不加仓、不减仓',
  )
  assert.equal(
    explicitActionLabel('维持观望', { terminal: true }),
    '本次不买入',
  )
  assert.equal(explicitActionLabel('观望'), '暂不买入')
  assert.equal(explicitActionLabel('等待确认'), '条件尚未确认')
  assert.equal(
    explicitActionLabel('到价复核：维持持有', {
      holdingMode: true,
      terminal: true,
    }),
    '到价复核：本次不加仓、不减仓',
  )
})

test('模糊的维持类执行文案改为当前动作和后续条件', () => {
  assert.equal(
    explicitActionInstruction(
      '维持持有：资金未转强；本次触发结束',
      { holdingMode: true, terminal: true },
    ),
    '本次不加仓、不减仓，继续持有现有仓位：资金未转强；本次触发结束',
  )
  assert.equal(
    explicitActionInstruction(
      '维持观望：量能不足；原触发价已消费',
      { terminal: true },
    ),
    '本次不买入：量能不足；原触发价已消费',
  )
  assert.equal(
    explicitActionInstruction(
      '结论：维持持有；今日买入仓位受T+1限制',
      { holdingMode: true, terminal: true },
    ),
    '结论：本次不加仓、不减仓，继续持有现有仓位；今日买入仓位受T+1限制',
  )
  assert.equal(
    explicitActionInstruction('等待突破10.20元并放量'),
    '本次不买入；突破10.20元并放量',
  )
})

test('建议文本递归转译但不改写程序使用的结构字段', () => {
  const result = humanizeAdviceTextFields({
    invalidation: 'marketEnv.regime不再为RISK_OFF时重新评估',
    knowledgeActionPlan: {
      invalidation: 'productionEligible=true后重新评估',
    },
    decisionPlan: {
      actionability: 'RESEARCH_ONLY',
      strategy: {
        strategyId: 'market-quant-resonance',
        specVersion: 'strategy.demo',
      },
      blockedReasons: ['blockerCodes包含BACKTEST_REQUIRED'],
    },
  })

  assert.equal(result.decisionPlan.actionability, 'RESEARCH_ONLY')
  assert.equal(
    result.decisionPlan.strategy.specVersion,
    'strategy.demo',
  )
  assert.doesNotMatch(result.invalidation, /marketEnv|RISK_OFF/)
  assert.doesNotMatch(
    result.knowledgeActionPlan.invalidation,
    /productionEligible/,
  )
  assert.doesNotMatch(
    result.decisionPlan.blockedReasons[0],
    /blockerCodes/,
  )
})

test('旧建议进入展示层时也不会泄露内部字段名', () => {
  const view = buildAdvicePresentation({
    action: '观望',
    actionPlan: 'strategyRoute为SHADOW_ONLY，继续等待',
    invalidation:
      'productionEligible为真且marketEnv.regime不再为RISK_OFF时，观望失效。',
  })

  assert.doesNotMatch(view.execution.instruction, /strategyRoute|SHADOW_ONLY/)
  assert.doesNotMatch(
    view.trigger.invalidation,
    /productionEligible|marketEnv|RISK_OFF/,
  )
  assert.match(view.trigger.invalidation, /重新评估是否买入/)
})

test('Markdown、数字高亮和推理展示统一经过用户语言转换', () => {
  for (const path of [
    'src/components/AIAssistant.jsx',
    'src/components/DailyReport.jsx',
    'src/components/Md.jsx',
    'src/components/PortfolioAnalysis.jsx',
    'src/components/RichText.jsx',
    'src/components/Reasoning.jsx',
    'src/components/SectorForecast.jsx',
  ]) {
    assert.match(read(path), /humanize(?:UserFacingText|AdviceTextFields)/)
  }
})
