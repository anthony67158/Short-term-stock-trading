import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADVISOR_DEEP_SYSTEM,
  ADVISOR_SYSTEM,
  ADVISOR_FAST_SYSTEM,
  buildUserPrompt,
  maxTokensForMode,
} from '../api/_ai_prompts.js'

test('快速与深度建议都使用可交付的有界输出预算', () => {
  assert.equal(maxTokensForMode('hold_advice', false), 3200)
  assert.equal(maxTokensForMode('buy_advice', false), 3200)
  assert.equal(maxTokensForMode('review', false), 3200)
  assert.equal(maxTokensForMode('hold_advice', true), 8000)
  assert.ok(ADVISOR_SYSTEM.length < 2200)
  assert.ok(ADVISOR_FAST_SYSTEM.length < 2500)
  assert.match(ADVISOR_DEEP_SYSTEM, /同一战术合同/)
  assert.match(ADVISOR_DEEP_SYSTEM, /最强反方/)
  assert.match(ADVISOR_DEEP_SYSTEM, /最多五个检查点/)
  assert.match(ADVISOR_DEEP_SYSTEM, /内化为短线经验/)
  assert.match(ADVISOR_DEEP_SYSTEM, /不得为了引用而引用/)
})

test('所有军师模式都只使用紧凑短线战术合同', () => {
  for (const mode of [
    'buy_advice',
    'hold_advice',
    't_advice',
    'review',
    'plan',
  ]) {
    const prompt = buildUserPrompt(mode, { code: '600000' })
    assert.match(prompt, /短线战术合同/)
    assert.doesNotMatch(prompt, /顶级操盘理论·融会贯通/)
    assert.ok(prompt.length < 6000, `${mode} prompt过长`)
    const deepPrompt = buildUserPrompt(mode, {
      code: '600000',
      generationProfile: 'DEEP',
    })
    assert.match(deepPrompt, /深度研判事实契约/)
    assert.doesNotMatch(deepPrompt, /股神|六条同源理论/)
    assert.ok(deepPrompt.length < 7000, `${mode} deep prompt过长`)
  }
})

test('军师生成前必须服从短线内核给出的唯一允许动作集合', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      timing: {
        state: 'TOO_EXTENDED',
        pullbackPrice: 9.8,
        reviewAfter: 'PRICE',
      },
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['WATCH'],
        canIncreaseRisk: false,
        reasons: ['价格位置过热，禁止追涨'],
        nextReviewTrigger: '回踩9.8元确认承接后重新评估',
      },
    },
  })

  assert.match(prompt, /唯一允许动作/)
  assert.match(prompt, /本轮action只能从观望中选择/)
  assert.match(prompt, /价格位置过热，禁止追涨/)
  assert.match(prompt, /不得把集合外动作写成当前可执行/)
})

test('市场硬红线在快速与深度提示词中都禁止逆势开仓', () => {
  const payload = {
    code: '600000',
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      market: {
        hardRiskOff: true,
        hardRiskSignals: ['炸板率45%超过40%'],
      },
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['WATCH'],
        canIncreaseRisk: false,
      },
    },
  }
  const fast = buildUserPrompt('buy_advice', payload)
  const deep = buildUserPrompt('buy_advice', {
    ...payload,
    generationProfile: 'DEEP',
  })

  assert.match(fast, /市场红线优先于逆势强票例外/)
  assert.match(deep, /无论个股是否逆势强都禁止新增风险/)
})

test('试仓档位强制模型输出5%以内并要求人工确认', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['BUY', 'WATCH'],
        canIncreaseRisk: true,
        riskTier: 'PROBE',
        maxPositionPct: 5,
        manualConfirmationOnly: true,
        reasons: ['成交额证据不足，仅允许受控试仓'],
      },
    },
  })

  assert.match(prompt, /最多只能输出“小仓试错\/小仓加仓”/)
  assert.match(prompt, /仓位不得超过总资产5%/)
  assert.match(prompt, /必须人工确认/)
  assert.match(prompt, /必须给出可立即人工确认的具体buyPrice/)
  assert.match(prompt, /不得只给回踩或突破观察价/)
  assert.match(prompt, /盈亏比至少1.8:1/)
})

test('休市时模型保留下一时段试仓预案而不是只写等待盘中', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['WATCH'],
        executionOpen: false,
        riskTier: 'PROBE',
        nextSessionPlan: {
          action: 'PROBE',
          session: 'AFTERNOON',
          maxPositionPct: 5,
        },
      },
    },
  })

  assert.match(prompt, /当前action必须为观望/)
  assert.match(prompt, /下午盘中条件试仓/)
  assert.match(prompt, /这不是普通观望/)
  assert.match(prompt, /触发后只确认入场时机并生成具体执行价/)
  assert.match(prompt, /仓位不超过5%/)
  assert.match(prompt, /不得只写等待盘中/)
})

test('条件试仓到价后只确认入场时机并要求输出具体价格', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    reviewEvent: {
      kind: 'price-review',
      reviewMode: 'ENTRY_CONFIRMATION',
      plannedAction: 'PROBE',
      actionLabel: '条件试仓',
      directionApproved: true,
      maxPositionPct: 5,
      manualConfirmationOnly: true,
      threshold: 10,
      price: 10.02,
    },
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      timing: { state: 'READY' },
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['BUY', 'WATCH'],
        executionOpen: true,
        riskTier: 'PROBE',
        maxPositionPct: 5,
        manualConfirmationOnly: true,
      },
    },
  })

  assert.match(prompt, /方向已通过的条件试仓复核/)
  assert.match(prompt, /不是从零重新决定方向/)
  assert.match(prompt, /具体buyPrice、stopPrice、targetPrice和planQty/)
  assert.match(prompt, /仓位不得超过5%/)
})

test('普通观望到价后只重新评估方向且不继承试仓承诺', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
    reviewEvent: {
      kind: 'price-review',
      reviewMode: 'REASSESSMENT',
      plannedAction: 'WATCH',
      actionLabel: '观望',
      directionApproved: false,
      threshold: 10,
      price: 10.02,
    },
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      timing: { state: 'WAIT_BREAKOUT' },
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['WATCH'],
        executionOpen: true,
        riskTier: 'NONE',
      },
    },
  })

  assert.match(prompt, /普通观望复核/)
  assert.match(prompt, /没有预先买入或试仓授权/)
  assert.match(prompt, /不得沿用条件试仓措辞/)
})

test('持仓加仓复核价到达后只评估是否加仓', () => {
  const prompt = buildUserPrompt('hold_advice', {
    code: '003036',
    reviewEvent: {
      kind: 'price-review',
      reviewMode: 'REASSESSMENT',
      plannedAction: 'WATCH',
      actionLabel: '重新评估加仓',
      directionApproved: false,
      threshold: 52.06,
      price: 52.16,
    },
    shortHorizonTactical: {
      schemaVersion: 'short-horizon-tactical.v1',
      timing: { state: 'READY' },
      actionPolicy: {
        schemaVersion: 'short-horizon-action-policy.v1',
        allowedActions: ['ADD', 'HOLD', 'REDUCE', 'EXIT', 'WATCH'],
        executionOpen: true,
        riskTier: 'PROBE',
      },
    },
  })

  assert.match(prompt, /持仓加仓条件复核/)
  assert.match(prompt, /重新评估是否加仓/)
  assert.match(prompt, /否则继续持有并写明本轮不加仓原因/)
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
  assert.match(prompt, /"label":"减仓\/清仓"/)
  assert.match(prompt, /"winRate":0/)
  assert.match(prompt, /"score":72/)
  assert.match(prompt, /上一版权威主计划/)
  assert.match(prompt, /无客观失效证据不得反转/)
  assert.match(prompt, /plan-600000/)
  assert.match(prompt, /短线战术合同/)
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
  assert.match(prompt, /"holdCost":10\.25/)
  assert.match(prompt, /"holdQty":3/)
  assert.match(prompt, /"cash":18600/)
  assert.match(prompt, /"stockWeight":18\.5/)
  assert.match(prompt, /positionNote.*关键账户数字/)
  assert.match(prompt, /"nextOpenPlan":/)
  assert.match(prompt, /"futurePlan":/)
  assert.match(prompt, /高开、平开、低开/)
  assert.match(prompt, /T\+1/)
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

  assert.match(prompt, /"riskTone":"RISK_OFF"/)
  assert.match(prompt, /"highConfidence":false/)
  assert.match(prompt, /个股逆势强、量化高把握和账户风险同时允许/)
  assert.match(prompt, /任一不足必须观望/)
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

  assert.match(prompt, /短线战术合同/)
  assert.match(prompt, /新能源车/)
  assert.match(prompt, /"stockRole":"LEADER"/)
  assert.match(prompt, /板块前排只能提高关注优先级/)
  assert.match(prompt, /不能绕过个股与账户条件/)
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
    assert.match(prompt, /观察价不是买入价/)
    assert.match(prompt, /buyPrice必须不高于输入中的当前价/)
    assert.match(prompt, /上方压力或突破位只能填breakoutWatchPrice/)
    assert.match(prompt, /pullbackWatchPrice/)
    assert.match(prompt, /breakoutWatchPrice/)
    assert.match(prompt, /未来1-5个交易日/)
    assert.match(prompt, /stopPrice.*targetPrice.*null/)
    assert.match(prompt, /过远、已经越过或无依据时填null/)
    assert.match(prompt, /invalidation只写何时取消关注/)
  }
})

test('买入建议必须同时给出T加一次日应对和五日内退出路径', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600000',
  })

  assert.match(prompt, /"nextOpenPlan":/)
  assert.match(prompt, /"futurePlan":/)
  assert.match(prompt, /T\+1/)
  assert.match(prompt, /最迟第5个交易日/)
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
  assert.match(prompt, /"samples":12/)
  assert.match(prompt, /"riskScale":1\.1/)
  assert.match(prompt, /只能校准本次置信与风险倍率/)
  assert.match(prompt, /绝不能绕过账户硬约束/)
})

test('军师明确把动作价位手数视为候选并服从统一决策编译器', () => {
  assert.match(ADVISOR_SYSTEM, /Decision Compiler/)
  assert.match(ADVISOR_SYSTEM, /价格、手数和金额只是候选/)
  assert.match(ADVISOR_SYSTEM, /证据完整性/)
  assert.match(ADVISOR_SYSTEM, /盈亏比/)
  assert.doesNotMatch(ADVISOR_SYSTEM, /strategyGate|strategyRoute/)
  assert.match(ADVISOR_SYSTEM, /严禁原样写进/)
  assert.match(ADVISOR_FAST_SYSTEM, /内部枚举和字段名/)
  assert.match(ADVISOR_FAST_SYSTEM, /至少1\.8:1盈亏比/)
})

test('所有军师模式都要求价格可追溯且无法核验时留空', () => {
  for (const prompt of [ADVISOR_SYSTEM, ADVISOR_FAST_SYSTEM]) {
    assert.match(prompt, /价格证据链/)
    assert.match(prompt, /tactical\.prices/)
    assert.match(prompt, /无法追溯就填null/)
    assert.match(prompt, /禁止猜价/)
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

  assert.match(prompt, /短线战术合同/)
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

  assert.match(prompt, /"title":"守住10元继续持有"/)
  assert.match(prompt, /"actionPlan":"跌破10元减仓1手"/)
  assert.match(prompt, /"invalidation":"收盘跌破10元"/)
  assert.match(prompt, /"stopPrice":10/)
  assert.doesNotMatch(prompt, /UNUSED_RUNTIME_PAYLOAD/)
})

test('显式深度生成使用紧凑事实契约而不丢失价格与资金约束', () => {
  const bulkyMarker = 'UNUSED_DEEP_PAYLOAD'.repeat(2000)
  const prompt = buildUserPrompt('buy_advice', {
    generationProfile: 'DEEP',
    code: '600000',
    name: '测试股份',
    todayQuote: {
      live: true,
      price: 10,
      limitDownPrice: 9,
      limitUpPrice: 11,
    },
    account: { totalAssets: 100000, cash: 50000 },
    stockFund: { mainNetYi: 0.8, retailNetYi: -0.2 },
    quant: {
      score: 72,
      forecast: { upProb: 64, targetLow: 10.2, targetHigh: 10.8 },
    },
    evidenceSnapshot: { raw: bulkyMarker },
    executionPlan: { raw: bulkyMarker },
  }, '')

  assert.match(prompt, /深度研判事实契约/)
  assert.match(prompt, /"limitDown":9/)
  assert.match(prompt, /"mainNetYi":0.8/)
  assert.match(prompt, /"retailNetYi":-0.2/)
  assert.match(prompt, /"quantTargetHigh":10.8/)
  assert.match(prompt, /主动做多必须满足风险预算与盈亏比至少1\.8:1/)
  assert.doesNotMatch(prompt, /UNUSED_DEEP_PAYLOAD/)
  assert.ok(prompt.length < 7000)
})

test('旧客户端携带的策略治理字段不会进入军师提示词', () => {
  const prompt = buildUserPrompt('buy_advice', {
    generationProfile: 'DEEP',
    code: '600000',
    name: '测试股份',
    strategyGate: {
      productionEligible: false,
      blockerCodes: ['BACKTEST_REQUIRED'],
    },
    strategyRoute: {
      production: null,
      research: { actionability: 'SHADOW_ONLY' },
    },
    previousAdvice: {
      action: '观望',
      actionPlan: '策略审核通过后再买入',
      invalidation: 'productionEligible=true后重新评估',
    },
  })

  assert.doesNotMatch(
    prompt,
    /productionEligible|strategyRoute|SHADOW_ONLY|BACKTEST_REQUIRED/,
  )
  assert.match(prompt, /按当前量价、资金与风险条件重新评估/)
})
