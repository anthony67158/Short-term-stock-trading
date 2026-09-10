import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpportunityRadar,
  resolveOpportunityRadarPhase,
} from '../shared/opportunityRadar.js'

const NOW = Date.parse('2026-09-02T10:00:00+08:00')

function directScore(overrides = {}) {
  return {
    schemaVersion: 'opportunity-score.v1',
    state: 'READY',
    usagePolicy: 'DIRECT',
    modelVersion: 'v3-production',
    pFill: 0.72,
    pWinGivenFill: 0.58,
    expectedNetR: 0.24,
    netRLowerBound: -0.05,
    expectedShortfall10: -0.8,
    calibration: { sampleCount: 1000 },
    ...overrides,
  }
}

function sectorSnapshot({
  session = 'intraday',
  signalDate = '2026-09-02',
} = {}) {
  return {
    schemaVersion: 'sector-forecast.v1',
    session,
    signalDate,
    generatedAt: NOW - 60_000,
    dataAsOf: '2026-09-02 09:59',
    sectors: [{
      code: 'BK1001',
      name: '先进制造',
      rank: 2,
      layoutRank: 1,
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      timing: {
        lane: 'EARLY_LAYOUT',
        layoutScore: 86,
      },
      forecast: {
        next: { score: 82 },
        week: { score: 76 },
      },
      reasons: ['主力资金连续改善'],
      risks: ['板块扩散仍需确认'],
      stocks: [{
        code: '600001',
        name: '示例股份',
        entryStage: 'EARLY_LAYOUT',
        entryLabel: '提前布局',
        price: 10.04,
        pct: 1.2,
        mainInflow: 1.4,
      }, {
        code: '600002',
        name: '方向候选',
        entryStage: 'EARLY_LAYOUT',
        entryLabel: '提前布局',
        price: 8.2,
        pct: 0.8,
        mainInflow: 0.6,
      }],
    }],
  }
}

function formulaCandidate(overrides = {}) {
  return {
    code: '600001',
    name: '示例股份',
    rank: 1,
    score: 88,
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    validationState: 'OBSERVE_ONLY',
    action: 'WATCH_BUY',
    primaryPrice: 10,
    priceType: 'PULLBACK_WATCH',
    stopPrice: 9.6,
    targetPrice: 10.8,
    riskReward: 2,
    validUntil: NOW + 60 * 60 * 1000,
    evidence: ['回踩均价线后重新站稳'],
    blockers: [],
    opportunityScore: directScore(),
    quote: {
      price: 10.04,
      amount: 250_000_000,
    },
    sector: {
      code: 'BK1001',
      name: '先进制造',
      rank: 2,
      phase: 'ACCUMULATION',
      actionability: 'LAYOUT',
      nextScore: 82,
    },
    ...overrides,
  }
}

function formulaResult(mode, candidates, {
  tradeDate = '2026-09-02',
  dataAsOf = NOW - 30_000,
} = {}) {
  return {
    schemaVersion: 'formula-selection.v1',
    mode,
    tradeDate,
    generatedAt: dataAsOf,
    dataAsOf,
    candidates,
  }
}

test('交易阶段决定机会雷达默认视图', () => {
  assert.deepEqual(resolveOpportunityRadarPhase({
    market: { phase: 'preopen' },
    now: NOW,
  }), {
    phase: 'PREOPEN',
    defaultLane: 'next',
  })
  assert.equal(resolveOpportunityRadarPhase({
    market: { phase: 'live' },
    now: NOW,
  }).defaultLane, 'intraday')
  assert.equal(resolveOpportunityRadarPhase({
    market: { phase: 'lunch' },
    now: NOW,
  }).defaultLane, 'intraday')
  assert.equal(resolveOpportunityRadarPhase({
    market: { phase: 'closed', tradingDay: true },
    now: NOW,
  }).defaultLane, 'next')
})

test('生产V3盘中机会保留完整退出计划并按动作价值小仓验证', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
      latest: sectorSnapshot({ session: 'close' }),
    },
    formula: {
      intraday: formulaResult('INTRADAY', [formulaCandidate()]),
    },
  })

  assert.equal(result.schemaVersion, 'opportunity-radar.v2')
  assert.equal(result.defaultLane, 'intraday')
  assert.equal(result.lanes.intraday[0].state, 'WAIT_TRIGGER')
  assert.equal(result.lanes.intraday[0].adaptive.tier, 'PROBE')
  assert.equal(result.lanes.intraday[0].entryPlan.price, 10)
  assert.ok(result.lanes.intraday[0].entryPlan.maxPositionPct > 0)
  assert.ok(result.lanes.intraday[0].entryPlan.maxPositionPct <= 6)
  assert.ok(result.lanes.intraday[0].adaptive.risk.riskPct > 0)
  assert.equal(result.lanes.intraday[0].exitPlan.hardStopPrice, 9.6)
  assert.equal(result.lanes.intraday[0].exitPlan.takeProfitPrice, 10.8)
  assert.equal(result.lanes.intraday[0].exitPlan.timeStopDate, '2026-09-07')
  assert.equal(
    result.lanes.intraday[0].opportunityScore.state,
    'READY',
  )
  assert.equal(
    result.lanes.intraday[0].opportunityScore.usagePolicy,
    'DIRECT',
  )
  assert.deepEqual(
    result.lanes.intraday[0].sourceSignals,
    ['板块前瞻', '盘中回踩承接'],
  )
})

test('同一状态内按费后净期望下界而不是热度分排序', () => {
  const highScoreLowEdge = formulaCandidate({
    code: '600001',
    score: 95,
    opportunityScore: {
      state: 'READY',
      usagePolicy: 'DIRECT',
      shadowOnly: false,
      productionEligible: true,
      pFill: 0.8,
      pWinGivenFill: 0.58,
      expectedNetR: 0.12,
      netRLowerBound: 0.02,
    },
  })
  const lowScoreHighEdge = formulaCandidate({
    code: '600002',
    name: '更高期望',
    score: 78,
    opportunityScore: {
      state: 'READY',
      usagePolicy: 'DIRECT',
      shadowOnly: false,
      productionEligible: true,
      pFill: 0.7,
      pWinGivenFill: 0.62,
      expectedNetR: 0.3,
      netRLowerBound: 0.11,
    },
  })
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {
      intraday: formulaResult(
        'INTRADAY',
        [highScoreLowEdge, lowScoreHighEdge],
      ),
    },
  })

  assert.deepEqual(
    result.lanes.intraday.map((item) => item.code),
    ['600002', '600001'],
  )
})

test('校准后的负期望候选保留展示但降为本次不买', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {
      intraday: formulaResult('INTRADAY', [
        formulaCandidate({
          opportunityScore: {
            state: 'READY',
            usagePolicy: 'DIRECT',
            shadowOnly: false,
            productionEligible: true,
            pFill: 0.76,
            pWinGivenFill: 0.52,
            expectedNetR: -0.08,
            netRLowerBound: -0.16,
          },
        }),
      ]),
    },
  })

  assert.equal(result.lanes.intraday[0].state, 'AVOID')
  assert.match(
    result.lanes.intraday[0].blockers.join('；'),
    /费后期望不大于0/,
  )
})

test('预催化候选只进入提前布局并保留官方事件证据', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {},
    preCatalyst: {
      latest: {
        schemaVersion: 'pre-catalyst.v1',
        tradeDate: '2026-09-02',
        generatedAt: NOW - 10_000,
        candidates: [{
          code: '600003',
          name: '潜伏股份',
          state: 'WAIT_TRIGGER',
          stateLabel: '潜伏预判',
          origin: 'PRE_CATALYST',
          activationScore: 78,
          riskReward: 1.8,
          quote: { price: 10, pct: 0.5, amount: 100_000_000 },
          sector: {
            code: 'BK1001',
            name: '先进制造',
            actionability: 'WAIT_PULLBACK',
          },
          entryPlan: {
            type: 'BREAKOUT',
            price: 10.2,
            maxPositionPct: 3,
          },
          exitPlan: {
            hardStopPrice: 9.7,
            takeProfitPrice: 11.1,
          },
          event: {
            eventLabel: '重大订单',
            title: '关于签订重大销售合同的公告',
            sourceAuthority: 'OFFICIAL',
          },
          sourceSignals: ['预催化扫描', '重大订单', '公告主体'],
          evidence: ['官方公告：关于签订重大销售合同的公告'],
          blockers: [],
          opportunityScore: directScore(),
        }],
      },
      task: { status: 'DONE' },
    },
  })

  const candidate = result.lanes.intraday.find(
    (item) => item.code === '600003',
  )
  assert.equal(result.sourceStatus.preCatalyst.status, 'fresh')
  assert.equal(candidate.state, 'WAIT_TRIGGER')
  assert.equal(candidate.stateLabel, '小仓验证')
  assert.equal(candidate.origin, 'PRE_CATALYST')
  assert.equal(
    result.lanes.intraday.some((item) => item.state === 'READY'),
    false,
  )
  assert.ok(result.lanes.next.some((item) => item.code === '600003'))
})

test('正式公式命中同股时不继承预催化校准阻断', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {
      intraday: formulaResult('INTRADAY', [formulaCandidate()]),
    },
    preCatalyst: {
      latest: {
        tradeDate: '2026-09-02',
        generatedAt: NOW - 10_000,
        candidates: [{
          code: '600001',
          name: '示例股份',
          origin: 'PRE_CATALYST',
          activationScore: 76,
          riskReward: 2,
          entryPlan: { type: 'BREAKOUT', price: 10.2 },
          exitPlan: {
            hardStopPrice: 9.7,
            takeProfitPrice: 11.2,
          },
          blockers: [
            '预催化模型仍在积累样本，仅可等待量价确认',
          ],
        }],
      },
    },
  })

  const candidate = result.lanes.intraday.find(
    (item) => item.code === '600001',
  )
  assert.equal(candidate.state, 'WAIT_TRIGGER')
  assert.equal(candidate.adaptive.tier, 'PROBE')
  assert.equal(
    candidate.blockers.includes(
      '预催化模型仍在积累样本，仅可等待量价确认',
    ),
    false,
  )
})

test('收盘公式与尾盘反转进入不同业务页签且不互相混合', () => {
  const closeCandidate = formulaCandidate({
    formulaId: 'CLOSE_TREND_PULLBACK',
    primaryPrice: 10.1,
    quote: { price: 10.3, amount: 300_000_000 },
  })
  const tailCandidate = {
    code: '600001',
    name: '示例股份',
    rank: 1,
    score: 92,
    quote: { price: 10.3, amount: 300_000_000 },
    sector: closeCandidate.sector,
    evidence: ['尾盘结构命中'],
    blockers: [],
    entryPlan: {
      type: 'IMMEDIATE',
      price: 10.3,
      maxPositionPct: 5,
    },
    exitPlan: {
      hardStopPrice: 9.8,
      takeProfitPrice: 10.9,
      timeStopDate: '2026-09-07',
      rule: '次日冲高1%-3%减半',
    },
    riskReward: 1.2,
    opportunityScore: directScore({
      priceContract: {
        entryPrice: 10.3,
        stopPrice: 9.8,
        targetPrice: 10.9,
      },
    }),
    execution: {
      role: 'PRIMARY',
      action: '尾盘确认后观察介入',
      firstLeg: '14:50-14:52第一笔',
      secondLeg: '14:53-14:55确认后第二笔',
      maxPositionPct: 5,
      stopPrice: 9.8,
      takeProfit: '次日冲高1%-3%减半',
      finalExitDate: '2026-09-07',
    },
  }
  const result = buildOpportunityRadar({
    now: Date.parse('2026-09-02T15:20:00+08:00'),
    sector: {
      market: {
        phase: 'closed',
        tradingDay: true,
        day: '2026-09-02',
      },
      latest: sectorSnapshot({ session: 'close' }),
    },
    formula: {
      close: formulaResult('CLOSE', [closeCandidate]),
      tail: {
        session: {
          tradeDate: '2026-09-02',
          isFormal: true,
          dataAsOf: NOW,
        },
        result: {
          candidates: [tailCandidate],
          nearCandidates: [],
        },
      },
    },
  })

  const intradayTail = result.lanes.intraday.find(
    (item) => item.code === '600001',
  )
  const nextClose = result.lanes.next.find(
    (item) => item.code === '600001',
  )
  assert.deepEqual(
    intradayTail.sourceSignals,
    ['板块前瞻', '尾盘反转'],
  )
  assert.deepEqual(
    nextClose.sourceSignals,
    ['板块前瞻', '收盘趋势回踩'],
  )
  assert.equal(intradayTail.exitPlan.timeStopDate, '2026-09-07')
  assert.match(intradayTail.exitPlan.rule, /次日冲高1%-3%减半/)
})

test('只有板块方向而没有价格合同时不生成个股候选', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {},
  })

  assert.equal(result.lanes.layout.length, 0)
  assert.equal(result.lanes.intraday.length, 0)
  assert.equal(result.lanes.next.length, 0)
  assert.equal(result.sectors[0].name, '先进制造')
})

test('较低赔率由成功概率定价但盘中快照过期仍不得展示', () => {
  const lowReward = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {
      intraday: formulaResult('INTRADAY', [
        formulaCandidate({ riskReward: 1.4 }),
      ]),
    },
  })
  const lowRewardCandidate = lowReward.lanes.intraday.find(
    (item) => item.code === '600001',
  )
  assert.equal(lowRewardCandidate.state, 'WAIT_TRIGGER')
  assert.ok(lowRewardCandidate.adaptive.estimate.expectedNetR > 0)
  assert.equal(lowRewardCandidate.riskReward, 1.4)

  const stale = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
    },
    formula: {
      intraday: formulaResult(
        'INTRADAY',
        [formulaCandidate()],
        { tradeDate: '2026-09-01' },
      ),
    },
  })
  assert.equal(stale.sourceStatus.formulaIntraday.status, 'stale')
  assert.equal(stale.lanes.intraday.length, 0)
})

test('板块实时源失败时公式候选最多进入等待确认', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
    },
    formula: {
      intraday: formulaResult('INTRADAY', [formulaCandidate()]),
    },
    sourceErrors: {
      sector: '板块快照读取失败',
    },
  })
  const candidate = result.lanes.intraday[0]
  assert.equal(candidate.state, 'WAIT_TRIGGER')
  assert.match(candidate.cautions.join('；'), /板块方向需要重新确认/)
  assert.equal(candidate.blockers.length, 0)
})

test('盘中只有昨日板块基线时不升级为当前可操作', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: {
        phase: 'live',
        tradingDay: true,
        day: '2026-09-02',
      },
      latest: sectorSnapshot({
        session: 'close',
        signalDate: '2026-09-01',
      }),
    },
    formula: {
      intraday: formulaResult('INTRADAY', [formulaCandidate()]),
    },
  })
  const candidate = result.lanes.intraday.find(
    (item) => item.code === '600001',
  )
  assert.equal(candidate.state, 'WAIT_TRIGGER')
  assert.match(candidate.cautions.join('；'), /板块方向需要重新确认/)
  assert.equal(candidate.blockers.length, 0)
})

test('收盘与尾盘结果必须属于最近完整交易日', () => {
  const result = buildOpportunityRadar({
    now: Date.parse('2026-09-02T15:20:00+08:00'),
    sector: {
      market: {
        phase: 'closed',
        tradingDay: true,
        day: '2026-09-02',
      },
      latest: sectorSnapshot({
        session: 'close',
        signalDate: '2026-09-02',
      }),
    },
    formula: {
      close: formulaResult(
        'CLOSE',
        [formulaCandidate({ formulaId: 'CLOSE_SQUEEZE' })],
        { tradeDate: '2026-09-01' },
      ),
      tail: {
        session: {
          tradeDate: '2026-09-01',
          isFormal: true,
          dataAsOf: NOW,
        },
        result: { candidates: [], nearCandidates: [] },
      },
    },
  })
  assert.equal(result.sourceStatus.formulaClose.status, 'manual')
  assert.equal(result.sourceStatus.tail.status, 'stale')
  assert.equal(
    result.lanes.next.some((item) =>
      item.sourceSignals.some((signal) =>
      signal.includes('收盘') || signal.includes('尾盘')
      )
    ),
    false,
  )
})

test('盘中次日计划不复用昨日尾盘和收盘公式并显示今日生成时间', () => {
  const now = Date.parse('2026-09-03T14:45:00+08:00')
  const currentSector = sectorSnapshot({
    session: 'intraday',
    signalDate: '2026-09-03',
  })
  currentSector.generatedAt = now - 60_000
  currentSector.dataAsOf = '2026-09-03 14:44'
  currentSector.sectors[0].stocks[0].price = 12.34
  const oldSector = sectorSnapshot({
    session: 'close',
    signalDate: '2026-09-02',
  })
  oldSector.sectors[0].stocks[0].price = 10.04
  const oldTail = {
    session: {
      tradeDate: '2026-09-02',
      isFormal: true,
      dataAsOf: Date.parse('2026-09-02T14:50:00+08:00'),
    },
    result: {
      candidates: [{
        code: '600003',
        name: '昨日尾盘股',
        quote: {
          price: 20,
          pct: 3,
          tradeDate: '2026-09-02',
        },
        blockers: [],
        entryPlan: {
          type: 'IMMEDIATE',
          price: 8.83,
          maxPositionPct: 5,
        },
        exitPlan: {
          hardStopPrice: 8.4,
          takeProfitPrice: 9.4,
          timeStopDate: '2026-09-08',
        },
        riskReward: 1.33,
        opportunityScore: directScore({
          priceContract: {
            entryPrice: 8.83,
            stopPrice: 8.4,
            targetPrice: 9.4,
          },
        }),
        execution: {
          stopPrice: 19,
          finalExitDate: '2026-09-07',
          maxPositionPct: 5,
        },
      }],
      nearCandidates: [],
    },
  }
  const result = buildOpportunityRadar({
    now,
    sector: {
      market: {
        phase: 'live',
        tradingDay: true,
        day: '2026-09-03',
      },
      intraday: currentSector,
      latest: oldSector,
    },
    formula: {
      close: formulaResult(
        'CLOSE',
        [formulaCandidate({ formulaId: 'CLOSE_SQUEEZE' })],
        { tradeDate: '2026-09-02' },
      ),
    },
    tail: {
      session: {
        status: 'BEFORE_WINDOW',
        tradeDate: '2026-09-03',
      },
      latest: oldTail,
      displayResult: oldTail,
      task: {
        tradeDate: '2026-09-02',
        status: 'DONE',
      },
    },
  })

  assert.equal(result.sourceStatus.tail.status, 'scheduled')
  assert.equal(result.sourceStatus.tail.message, '14:50自动生成')
  assert.equal(result.sourceStatus.formulaClose.status, 'manual')
  assert.equal(result.sourceStatus.formulaClose.message, '收盘后手动生成')
  assert.ok(result.sourceStatus.tail.refreshAt > now)
  assert.equal(
    result.lanes.next.some((item) =>
      item.sourceSignals.includes('尾盘反转')
    ),
    false,
  )
  assert.equal(result.lanes.next.length, 0)
})

test('今日手动尾盘试算优先于昨日正式版进入次日计划', () => {
  const now = Date.parse('2026-09-03T14:47:00+08:00')
  const oldTail = {
    session: {
      tradeDate: '2026-09-02',
      isFormal: true,
      dataAsOf: Date.parse('2026-09-02T14:50:00+08:00'),
    },
    result: {
      candidates: [],
      nearCandidates: [],
    },
  }
  const currentManual = {
    session: {
      tradeDate: '2026-09-03',
      isFormal: false,
      dataAsOf: now - 1_000,
    },
    result: {
      candidates: [{
        code: '600004',
        name: '今日试算股',
        quote: {
          price: 8.8,
          pct: 1.2,
          tradeDate: '2026-09-03',
        },
        blockers: [],
        execution: {
          stopPrice: 8.4,
          finalExitDate: '2026-09-08',
          maxPositionPct: 5,
        },
      }],
      nearCandidates: [],
    },
  }
  const result = buildOpportunityRadar({
    now,
    sector: {
      market: {
        phase: 'live',
        tradingDay: true,
        day: '2026-09-03',
      },
      intraday: sectorSnapshot({
        session: 'intraday',
        signalDate: '2026-09-03',
      }),
    },
    tail: {
      session: {
        status: 'BEFORE_WINDOW',
        tradeDate: '2026-09-03',
      },
      latest: oldTail,
      displayResult: currentManual,
    },
  })

  assert.equal(result.sourceStatus.tail.status, 'fresh')
  const manualRow = result.lanes.intraday.find((item) =>
    item.code === '600004'
    && item.sourceSignals.includes('尾盘反转')
  )
  assert.ok(manualRow)
  assert.equal(manualRow.state, 'AVOID')
  assert.equal(manualRow.entryPlan, null)
  assert.equal(manualRow.exitPlan, null)
  assert.match(
    manualRow.blockers.join('；'),
    /手动试算仅供观察|V3评分不可用/,
  )
})

test('机会雷达为每个lane附加组合视图且不改变个股结论', () => {
  const result = buildOpportunityRadar({
    now: NOW,
    sector: {
      market: { phase: 'live', day: '2026-09-02' },
      intraday: sectorSnapshot(),
      latest: sectorSnapshot({ session: 'close' }),
    },
    formula: {
      intraday: formulaResult('INTRADAY', [formulaCandidate()]),
    },
  })

  // 三个 lane 都有组合视图
  assert.ok(result.portfolios)
  assert.equal(
    result.portfolios.intraday.schemaVersion,
    'opportunity-portfolio.v1',
  )
  // 组合视图不修改 lanes 里的个股 state
  const laneRow = result.lanes.intraday.find(
    (item) => item.code === '600001',
  )
  assert.equal(laneRow.state, 'WAIT_TRIGGER')
  assert.equal('portfolioState' in laneRow, false)
  // 组合视图里同一只股票被标注了 portfolioState
  const pf = result.portfolios.intraday.candidates.find(
    (item) => item.code === '600001',
  )
  assert.ok(pf)
  assert.equal(pf.state, 'WAIT_TRIGGER')
  assert.equal(typeof pf.portfolioState, 'string')
  assert.ok(result.portfolios.intraday.budget)
})
