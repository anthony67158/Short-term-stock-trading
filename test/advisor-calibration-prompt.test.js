import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADVISOR_SYSTEM,
  ADVISOR_FAST_SYSTEM,
  buildUserPrompt,
  maxTokensForMode,
} from '../api/_ai_prompts.js'

test('快速持仓建议使用精简正文预算而深度模式保留可交付长上下文', () => {
  assert.equal(maxTokensForMode('hold_advice', false), 3200)
  assert.equal(maxTokensForMode('buy_advice', false), 3200)
  assert.equal(maxTokensForMode('review', false), 3200)
  assert.equal(maxTokensForMode('hold_advice', true), 24000)
  assert.ok(ADVISOR_FAST_SYSTEM.length < ADVISOR_SYSTEM.length / 4)
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

test('板块前排机会允许受控人工试仓但不绕过个股和账户条件', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '002594',
    sectorOpportunity: {
      matched: true,
      probeEligible: true,
      sector: {
        name: '新能源车',
        actionability: 'LAYOUT',
      },
      stock: {
        roleLabel: '总龙头',
      },
    },
  })

  assert.match(prompt, /板块与个股联动/)
  assert.match(prompt, /新能源车/)
  assert.match(prompt, /总龙头/)
  assert.match(prompt, /应优先给“小仓试错”而不是泛泛“观望”/)
  assert.match(prompt, /不超过总资产5%/)
  assert.match(prompt, /不允许升级为“立即买入”/)
})

test('观望买入建议区分观察锚与买入价并比较两条入场路径', () => {
  const normalPrompt = buildUserPrompt('buy_advice', {
    code: '003031',
  })
  const fastPrompt = buildUserPrompt('buy_advice', {
    code: '003031',
    generationProfile: 'FAST',
  })

  for (const prompt of [normalPrompt, fastPrompt]) {
    assert.match(prompt, /观察锚.*不是买入价/)
    assert.match(prompt, /回踩支撑.*企稳/)
    assert.match(prompt, /放量突破.*确认/)
    assert.match(prompt, /当前低价.*不能买/)
    assert.match(prompt, /stopPrice.*targetPrice.*null/)
    assert.match(prompt, /尚未到达.*可核验.*watchPrice/)
    assert.match(prompt, /invalidation只写何时取消关注/)
  }
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

test('军师明确把动作价位手数视为候选并服从统一决策编译器', () => {
  assert.match(ADVISOR_SYSTEM, /Decision Compiler/)
  assert.match(ADVISOR_SYSTEM, /候选草案/)
  assert.match(ADVISOR_SYSTEM, /strategyGate\.productionEligible=false/)
  assert.match(ADVISOR_SYSTEM, /研究级条件建议/)
  assert.match(ADVISOR_SYSTEM, /strategyRoute/)
  assert.match(ADVISOR_SYSTEM, /SHADOW_ONLY/)
  assert.match(ADVISOR_SYSTEM, /严禁原样写进/)
  assert.match(ADVISOR_FAST_SYSTEM, /系统内部字段名/)
  assert.match(ADVISOR_FAST_SYSTEM, /市场处于防守状态/)
})

test('所有军师模式都要求价格可追溯且无法核验时留空', () => {
  for (const prompt of [ADVISOR_SYSTEM, ADVISOR_FAST_SYSTEM]) {
    assert.match(prompt, /价格证据链/)
    assert.match(prompt, /支撑|压力/)
    assert.match(prompt, /无法追溯.*null/)
    assert.match(prompt, /禁止.*猜价/)
  }
})

test('快速军师输出限制重复文案并保留核心证据', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    generationProfile: 'FAST',
    todayQuote: {
      price: 10,
      pct: 1,
      live: true,
      limitDownPrice: 9,
      limitUpPrice: 11,
    },
  }, '')

  assert.match(prompt, /军师快速决策/)
  assert.match(prompt, /只做一次结论/)
  assert.match(prompt, /每类证据最多一句/)
  assert.match(prompt, /不得换词重复/)
  assert.ok(prompt.length < 6000)
})

test('连续决策只传递上一版关键交易契约，不重复注入大对象', () => {
  const bulkyMarker = 'UNUSED_RUNTIME_PAYLOAD'.repeat(3000)
  const prompt = buildUserPrompt('hold_advice', {
    code: '600000',
    previousEvidenceDigest: { rawSnapshot: bulkyMarker },
    previousAdvice: {
      action: '持有',
      title: '守住10元继续持有',
      actionPlan: '跌破10元减仓1手',
      stopPrice: 10,
      targetPrice: 12,
      opQty: '减仓1手',
      invalidation: '收盘跌破10元',
      priceContract: {
        levels: [{ kind: 'stop', price: 10 }],
      },
      executionPlan: { raw: bulkyMarker },
      evidenceSnapshotRef: { raw: bulkyMarker },
      presentation: { raw: bulkyMarker },
    },
  })

  assert.match(prompt, /守住10元继续持有/)
  assert.match(prompt, /跌破10元减仓1手/)
  assert.match(prompt, /收盘跌破10元/)
  assert.match(prompt, /"stopPrice":10/)
  assert.doesNotMatch(prompt, /UNUSED_RUNTIME_PAYLOAD/)
})
