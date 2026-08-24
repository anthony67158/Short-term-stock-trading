import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  humanizeAdviceTextFields,
  humanizeUserFacingText,
} from '../shared/userFacingLanguage.js'
import { buildAdvicePresentation } from '../shared/advicePresentation.js'
import { buildStrategyResearchView } from '../shared/strategyResearch.js'

const INTERNAL_TERMS = [
  'productionEligible',
  'strategyRoute',
  'marketEnv.regime',
  'RISK_OFF',
  'SHADOW_ONLY',
  'RESEARCH_ONLY',
  'specVersion',
  'blockerCodes',
]

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

test('用户说明把策略内部字段改写成可执行中文', () => {
  const result = humanizeUserFacingText(
    '策略闸门productionEligible为真、策略路线进入生产可执行，且marketEnv.regime不再为RISK_OFF时，观望失效。',
  )

  assert.equal(
    result,
    '当策略通过实盘启用审核、当前行情匹配可执行策略，且市场结束防守状态时，重新评估是否买入。',
  )
  for (const term of INTERNAL_TERMS) {
    assert.equal(result.includes(term), false)
  }
})

test('通用术语转换保留价格、T+1和常用技术指标', () => {
  const result = humanizeUserFacingText(
    'strategyRoute为SHADOW_ONLY，actionability=BLOCKED，specVersion不一致；跌破10.20元且RSI转弱时按T+1处理。',
  )

  assert.match(result, /当前适用策略/)
  assert.match(result, /仅模拟观察/)
  assert.match(result, /暂不可执行/)
  assert.match(result, /策略版本/)
  assert.match(result, /10\.20元/)
  assert.match(result, /RSI/)
  assert.match(result, /T\+1/)
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

test('策略研究视图隐藏内部阻断代码并提供可读版本状态', () => {
  const view = buildStrategyResearchView({
    catalog: {
      data: [{
        strategyId: 'market-quant-resonance',
        specVersion: 'strategy.demo',
        name: '多因子共振',
        family: 'MULTI_FACTOR_RANKING',
        eligibleRegimes: ['TREND_STRONG', 'RISK_OFF'],
        horizon: { value: 5, unit: 'TRADING_DAY' },
      }],
    },
    governance: {
      strategies: [{
        strategyId: 'market-quant-resonance',
        state: 'shadow',
        blockers: [{
          code: 'BACKTEST_REQUIRED',
          message: '还需要完成样本外回测',
        }],
      }],
    },
  })

  assert.deepEqual(
    view.rows[0].eligibleRegimes,
    ['强趋势', '防守'],
  )
  assert.equal(view.rows[0].versionLabel, '规则版本已记录')
  assert.equal(view.rows[0].blockerText, '还需要完成样本外回测')
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
