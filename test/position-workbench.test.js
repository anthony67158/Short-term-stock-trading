import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  POSITION_WORKBENCH_VERSION,
  buildPositionWorkbench,
} from '../shared/positionWorkbench.js'

const now = Date.parse('2026-09-09T02:00:00.000Z')

function buyAdvice(code, utility) {
  return {
    mode: 'buy_advice',
    at: now,
    advice: {
      decisionSource: { engine: 'V3', state: 'READY' },
      selectedV3Plan: {
        route: 'IMMEDIATE',
        opportunityScore: { pFill: 0.8, expectedNetR: utility, netRLowerBound: 0.05 },
      },
      action: '立即买入',
      adaptiveAction: {
        selected: {
          route: 'IMMEDIATE',
          adaptive: {
            tier: 'ATTACK',
            utility,
            estimate: {
              pFill: 0.8,
              expectedNetR: utility,
              lowerNetR: 0.05,
            },
          },
        },
      },
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        decisionId: `decision-${code}`,
        action: 'BUY',
        actionability: 'READY',
        actionPolicy: {
          canIncreaseRisk: true,
          entryIntent: { state: 'READY_BUY' },
        },
        quantity: { lots: 1 },
        prices: { reference: 10, stop: 9.5, target: 11 },
        validUntil: new Date(now + 60_000).toISOString(),
      },
    },
  }
}

test('持仓工作台只聚合既有决策并按动作价值排列自选', () => {
  const book = {
    account: { totalAssets: 100_000, cash: 80_000 },
    holding: [],
    plan: [
      { code: '600001', name: '低价值', qScore: 95, targetPrice: 10 },
      { code: '600002', name: '高价值', qScore: 50, targetPrice: 10 },
    ],
    advice: {
      '600001': buyAdvice('600001', 0.08),
      '600002': buyAdvice('600002', 0.35),
    },
    alerts: [],
    executionPlans: [],
    closed: [],
  }
  const result = buildPositionWorkbench({
    book,
    quoteMap: {
      '600001': { code: '600001', price: 10 },
      '600002': { code: '600002', price: 10 },
    },
    opportunityRadar: {
      opportunityContext: {
        phase: 'ROTATION',
        hardRisk: false,
      },
      summary: { actionable: 2 },
    },
    now,
  })

  assert.equal(result.schemaVersion, POSITION_WORKBENCH_VERSION)
  assert.equal(result.primaryAction.code, '600002')
  assert.deepEqual(
    result.watchlist.map((item) => item.code),
    ['600002', '600001'],
  )
  assert.equal(
    result.watchlist[0].decisionPlan.decisionId,
    'decision-600002',
  )
  assert.equal(result.runtime.activeTrackingCount, 2)
})

test('普通收藏不读取旧建议且固定排在已纳入作战股票之后', () => {
  const book = {
    account: { totalAssets: 100_000, cash: 80_000 },
    holding: [],
    plan: [
      { code: '600001', name: '普通收藏', qScore: 99 },
      { code: '600002', name: '已纳入作战', qScore: 40 },
    ],
    advice: {
      '600001': buyAdvice('600001', 0.8),
      '600002': buyAdvice('600002', 0.2),
    },
    settings: {
      'advAuto.holdCodes': [],
      'advAuto.watchCodes': ['600002'],
    },
    alerts: [],
    executionPlans: [],
    closed: [],
  }

  const result = buildPositionWorkbench({
    book,
    quoteMap: {
      '600001': { code: '600001', price: 10 },
      '600002': { code: '600002', price: 10 },
    },
    now,
  })

  assert.deepEqual(
    result.watchlist.map((item) => item.code),
    ['600002', '600001'],
  )
  assert.equal(result.watchlist[0].managed, true)
  assert.equal(result.watchlist[1].managed, false)
  assert.equal(result.runtime.activeTrackingCount, 1)
  assert.equal(result.watchlist[1].decisionPlan, null)
  assert.equal(
    result.actions.find((item) => item.code === '600001').state,
    'EMPTY',
  )
})

test('普通弱市不覆盖已核定动作，确定性尾部风险才关闭新增风险', () => {
  const book = {
    account: { totalAssets: 100_000, cash: 80_000 },
    holding: [],
    plan: [{ code: '600001', name: '机会股' }],
    advice: { '600001': buyAdvice('600001', 0.3) },
    alerts: [],
    executionPlans: [],
    closed: [],
  }
  const quoteMap = {
    '600001': { code: '600001', price: 10 },
  }
  const weak = buildPositionWorkbench({
    book,
    quoteMap,
    opportunityRadar: {
      opportunityContext: {
        phase: 'RETREAT',
        hardRisk: false,
      },
    },
    now,
  })
  const tailRisk = buildPositionWorkbench({
    book,
    quoteMap,
    opportunityRadar: {
      opportunityContext: {
        phase: 'PANIC',
        hardRisk: true,
      },
    },
    now,
  })

  assert.equal(weak.actions[0].state, 'READY')
  assert.equal(tailRisk.actions[0].state, 'RISK_BLOCKED')
})

test('FC 持仓工作台接口保持账号鉴权、只读和禁缓存', () => {
  const source = readFileSync(
    new URL('../api/position_workbench.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /authenticateAccountRequest\(req\)/)
  assert.match(source, /req\.method !== 'GET'/)
  assert.match(source, /Cache-Control', 'no-store'/)
  assert.match(source, /buildPositionWorkbench/)
})

test('浏览器工作台读取带鉴权、禁缓存和独立超时', () => {
  const source = readFileSync(
    new URL('../src/positionWorkbench.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /accountRequestHeaders\(\)/)
  assert.match(source, /cache:\s*'no-store'/)
  assert.match(source, /REQUEST_TIMEOUT_MS = 15_000/)
  assert.match(source, /setTimeout\(abort, REQUEST_TIMEOUT_MS\)/)
})

test('今日作战纳入机会时同步授权并触发同源买入建议', () => {
  const source = readFileSync(
    new URL('../src/components/AdaptiveWorkbench.jsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /planStore\.setAdviceReviewEnabled\(opportunity\.code, true\)/)
  assert.match(source, /tryStartAdvice\(buildWatchSpec\(/)
  assert.match(source, /纳入作战并持续跟踪/)
})
