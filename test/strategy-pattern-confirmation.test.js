import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStrategyPatternConfirmationGuard,
  buildStrategyPatternConfirmation,
  evaluateStrategyPatternConfirmation,
  sanitizeStrategyPatternConfirmation,
} from '../shared/strategyPatternConfirmation.js'
import { projectAdviceAlerts } from '../shared/adviceAlerts.js'
import { sanitizeConfirmationBody } from '../api/confirm_signal.js'

function profile(patternId = 'PLATFORM_BREAKOUT', route = 'BREAKOUT') {
  return buildStrategyPatternConfirmation({
    pattern: {
      id: patternId,
      label: '测试形态',
      score: 88,
    },
    route,
  })
}

test('突破形态要求站稳触发位、均价线和量价延续', () => {
  const result = evaluateStrategyPatternConfirmation({
    observationAgeMs: 60_000,
    keyDistancePct: 0.12,
    aboveVwap: true,
    volSurge: false,
    mom5Pct: 0.3,
  }, profile())

  assert.equal(result.passed, true)
  assert.equal(result.passedGroups, result.totalGroups)
})

test('形态条件只能收紧确认，不能把等待提升为确认', () => {
  const missing = applyStrategyPatternConfirmationGuard({
    decision: 'confirm',
    score: 3,
    hits: ['通用信号通过'],
  }, {
    observationAgeMs: 60_000,
    keyDistancePct: -0.4,
    aboveVwap: false,
    volSurge: false,
    mom5Pct: -0.1,
  }, profile())
  const alreadyWaiting = applyStrategyPatternConfirmationGuard({
    decision: 'wait',
    score: 1,
    hits: [],
  }, {
    observationAgeMs: 60_000,
    keyDistancePct: 1,
    aboveVwap: true,
    volSurge: true,
    mom5Pct: 1,
  }, profile())

  assert.equal(missing.decision, 'wait')
  assert.match(missing.hits.at(-1), /形态确认未完成/)
  assert.equal(alreadyWaiting.decision, 'wait')
})

test('客户端不能自定义确认规则', () => {
  const clean = sanitizeStrategyPatternConfirmation({
    ...profile('SUPPORT_PULLBACK', 'PULLBACK'),
    groups: [{ anyOf: ['ALWAYS_TRUE'], label: '绕过规则' }],
  })

  assert.ok(clean)
  assert.equal(
    clean.groups.some((group) => group.anyOf.includes('ALWAYS_TRUE')),
    false,
  )
})

test('观察价预警携带服务端生成的形态确认合同', () => {
  const confirmation = profile('SUPPORT_PULLBACK', 'PULLBACK')
  const data = {
    plan: [{ code: '000001', name: '平安银行' }],
    holding: [],
    alerts: [],
    settings: {},
  }
  projectAdviceAlerts(data, '000001', {
    action: '观望',
    decisionPaths: [{
      route: 'PULLBACK',
      entryPlan: {
        strategyPatternConfirmation: confirmation,
      },
    }],
    priceContract: {
      schemaVersion: 'advice-price-contract.v1',
      currentPrice: 10,
      validationStatus: 'VERIFIED',
      levels: [{
        key: 'watch_pullback',
        field: 'pullbackWatchPrice',
        purpose: 'REVIEW_ONLY',
        label: '回踩观察',
        price: 9.8,
        direction: 'LTE',
        status: 'PENDING',
        strict: true,
        horizonPct: 5,
      }],
      allPricesStrict: true,
      issues: [],
      review: { operator: 'ALL', conditions: [], allMet: false },
    },
  }, {
    now: Date.now(),
    idFactory: () => 'pattern-alert',
    requirePriceContract: true,
  })

  assert.equal(data.alerts.length, 1)
  assert.equal(
    data.alerts[0].strategyPatternConfirmation.patternId,
    'SUPPORT_PULLBACK',
  )

  const watchingAt = Date.now()
  const sanitized = sanitizeConfirmationBody({
    alert: {
      ...data.alerts[0],
      phase: 'watching',
      watchingAt,
      watchingPrice: 9.8,
      strategyPatternConfirmation: {
        ...data.alerts[0].strategyPatternConfirmation,
        groups: [{ anyOf: ['ALWAYS_TRUE'] }],
      },
    },
    advice: {},
    quote: { price: 9.82 },
  })
  assert.equal(sanitized.ok, true)
  assert.equal(
    sanitized.value.alert.strategyPatternConfirmation.groups
      .some((group) => group.anyOf.includes('ALWAYS_TRUE')),
    false,
  )
})
