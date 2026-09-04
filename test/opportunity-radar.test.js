import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpportunityRadar,
  resolveOpportunityRadarPhase,
} from '../shared/opportunityRadar.js'

const NOW = Date.parse('2026-09-02T10:00:00+08:00')

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
    opportunityScore: {
      schemaVersion: 'opportunity-score.v1',
      state: 'NOT_READY',
      pFill: null,
    },
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

test('盘中公式与板块方向融合为包含退出计划的可操作机会', () => {
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
  assert.equal(result.lanes.intraday[0].state, 'READY')
  assert.equal(result.lanes.intraday[0].entryPlan.price, 10)
  assert.equal(result.lanes.intraday[0].entryPlan.maxPositionPct, 5)
  assert.equal(result.lanes.intraday[0].exitPlan.hardStopPrice, 9.6)
  assert.equal(result.lanes.intraday[0].exitPlan.takeProfitPrice, 10.8)
  assert.equal(result.lanes.intraday[0].exitPlan.timeStopDate, '2026-09-09')
  assert.equal(
    result.lanes.intraday[0].opportunityScore.state,
    'NOT_READY',
  )
  assert.deepEqual(
    result.lanes.intraday[0].sourceSignals,
    ['板块前瞻', '盘中回踩承接'],
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

test('赔率不足或盘中快照过期时不得显示为可操作', () => {
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
  assert.equal(lowRewardCandidate.state, 'AVOID')
  assert.match(
    lowRewardCandidate.blockers.join('；'),
    /盈亏比不足/,
  )

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
  assert.match(candidate.blockers.join('；'), /板块方向需要重新确认/)
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
  assert.match(candidate.blockers.join('；'), /板块方向需要重新确认/)
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
  assert.equal(manualRow.entryPlan.price, 8.83)
  assert.equal(manualRow.exitPlan.hardStopPrice, 8.4)
  assert.match(manualRow.blockers.join('；'), /手动试算仅供观察/)
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
  assert.equal(laneRow.state, 'READY')
  assert.equal('portfolioState' in laneRow, false)
  // 组合视图里同一只股票被标注了 portfolioState
  const pf = result.portfolios.intraday.candidates.find(
    (item) => item.code === '600001',
  )
  assert.ok(pf)
  assert.equal(pf.state, 'READY')
  assert.equal(typeof pf.portfolioState, 'string')
  assert.ok(result.portfolios.intraday.budget)
})
