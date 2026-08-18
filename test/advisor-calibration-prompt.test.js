import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildUserPrompt,
  maxTokensForMode,
} from '../api/_ai_prompts.js'

test('快速持仓建议保留足够正文预算避免长JSON截断', () => {
  assert.equal(maxTokensForMode('hold_advice', false), 6000)
  assert.equal(maxTokensForMode('buy_advice', false), 6000)
  assert.equal(maxTokensForMode('review', false), 6000)
})

test('军师低命中校准按动作方向纠偏而不是一律变得更保守', () => {
  const prompt = buildUserPrompt('hold_advice', {
    code: '600000',
    name: '测试股份',
    advisorTrack: {
      overallWinRate: 27,
      overallTotal: 11,
      overallAvgPct: 3.05,
      modeWinRate: 0,
      modeTotal: 8,
      actionScores: [
        { kind: 'bear', label: '减仓/清仓', winRate: 0, total: 8, avgPct: 1.34 },
      ],
    },
    quant: {
      score: 72,
      bias: '偏多',
      forecast: {
        direction: '看涨',
        upProb: 64,
        expRet: 2.1,
        targetLow: 10.2,
        targetHigh: 10.8,
      },
    },
    previousAdvice: {
      planId: 'plan-600000',
      revision: 2,
      thesisVersion: 1,
      action: '持有',
      actionPlan: '守住9.80元继续持有',
      stopPrice: 9.8,
      targetPrice: 10.8,
      invalidation: '收盘跌破9.80元',
    },
  }, '')

  assert.match(prompt, /低命中不等于一律更保守/)
  assert.match(prompt, /减仓\/清仓 0%\(8次/)
  assert.match(prompt, /偏防守/)
  assert.match(prompt, /量化模型·价格参考因子/)
  assert.match(prompt, /综合分72/)
  assert.match(prompt, /上一版权威主计划/)
  assert.match(prompt, /无客观失效证据不得反转/)
  assert.match(prompt, /plan-600000/)
  assert.match(prompt, /知行合一·字段职责/)
  assert.match(prompt, /系统会在返回后统一生成知行合一交易契约/)
  assert.match(prompt, /输出格式·简洁去重/)
  assert.match(prompt, /同一事实只写一次/)
  assert.match(prompt, /actionPlan.*80字/)
  assert.doesNotMatch(prompt, /最终JSON必须额外给出 knowledgeActionPlan/)
  assert.doesNotMatch(prompt, /说明你过去偏乐观\/追高/)
})

test('持仓建议明确列出本次决策使用的持仓和可用资金快照', () => {
  const prompt = buildUserPrompt('hold_advice', {
    code: '600000',
    holdCost: 10.25,
    holdQty: 3,
    sellableTodayQty: 2,
    account: {
      cash: 18600,
      totalAssets: 52000,
      position: 64.2,
      stockWeight: 18.5,
    },
  })

  assert.match(prompt, /本次决策账户快照/)
  assert.match(prompt, /持仓3手/)
  assert.match(prompt, /成本10\.25元/)
  assert.match(prompt, /可用资金18600元/)
  assert.match(prompt, /单票占比18\.5%/)
  assert.match(prompt, /positionNote.*可用资金/)
})

test('弱市买入必须同时通过个股强势和高把握信号硬闸门', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    marketEnv: {
      score: 30,
      weak: true,
      level: '极弱',
      suggestPosition: '轻仓',
    },
    counterTrend: { isStrong: true },
    quant: {
      highConfSignal: { fired: false, credibility: 60 },
    },
    account: {
      cash: 30000,
      totalAssets: 80000,
      position: 62.5,
    },
  })

  assert.match(prompt, /弱市硬性入场闸门/)
  assert.match(prompt, /逆势强势.*高把握信号.*同时成立/)
  assert.match(prompt, /任一不满足.*观望/)
  assert.doesNotMatch(prompt, /共振分≥2且个股结构不坏，就应给出明确的做多/)
})

test('军师区分真实费后收益与三日建议命中统计', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    realOutcomeContext: {
      samples: 12,
      sampleQualified: true,
      posteriorWinRate: 58.3,
      profitFactor: 1.4,
      expectancy: 86,
      calibration: 'constructive',
      riskScale: 1.1,
    },
  })

  assert.match(prompt, /真实成交费后学习/)
  assert.match(prompt, /12笔完成验证且关联真实卖出/)
  assert.match(prompt, /风险倍率=1\.1/)
  assert.match(prompt, /只用于调节本次手数\/风险预算/)
  assert.match(prompt, /绝不能.*绕过账户硬闸门/)
})
