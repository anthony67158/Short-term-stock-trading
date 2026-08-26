import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adviceReviewDue,
  isAdviceReviewEnabled,
  nextAdviceReviewAt,
  setAdviceReviewEnabled,
} from '../shared/adviceReviewPolicy.js'
import { buildAdviceCacheEntry } from '../shared/adviceContinuity.js'

test('持仓建议在交易时段按15分钟安排下一次自动复核', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()

  assert.equal(
    nextAdviceReviewAt({ now, mode: 'hold_advice', intervalMin: 15 }),
    new Date('2026-08-10T02:15:00Z').getTime(),
  )
})

test('接近止损位时自动把持仓复核周期压缩到5分钟', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const entry = buildAdviceCacheEntry(null, {
    mode: 'hold_advice',
    reviewIntervalMin: 15,
    advice: {
      action: '持有',
      stopPrice: 9.8,
      targetPrice: 10.8,
      continuity: { changeType: 'initial' },
    },
    meta: {
      evidenceSnapshot: {
        evidence: {
          quote: { price: 9.84, pct: -1.2 },
          technical: {
            indicators: { atr: { atr: 0.2 } },
          },
        },
      },
    },
  }, now)

  assert.equal(entry.advice.reviewCycle.configuredIntervalMin, 15)
  assert.equal(entry.advice.reviewCycle.intervalMin, 5)
  assert.equal(entry.advice.reviewCycle.riskLevel, 'urgent')
  assert.match(entry.advice.reviewCycle.riskReasons.join('、'), /止损/)
  assert.equal(entry.advice.reviewCycle.nextReviewAt, now + 5 * 60000)
})

test('存在严格观望价时最多每5分钟检查一次是否穿越', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const entry = buildAdviceCacheEntry(null, {
    mode: 'buy_advice',
    reviewIntervalMin: 30,
    advice: {
      action: '观望',
      watchPrice: 10.5,
      priceContract: {
        schemaVersion: 'advice-price-contract.v1',
        validationStatus: 'VERIFIED',
        levels: [{
          key: 'watch',
          field: 'watchPrice',
          purpose: 'REVIEW_ONLY',
          price: 10.5,
          direction: 'GTE',
          status: 'PENDING',
          strict: true,
        }],
        allPricesStrict: true,
        issues: [],
        review: { operator: 'ALL', conditions: [], allMet: false },
      },
    },
    meta: {
      evidenceSnapshot: {
        evidence: {
          quote: { price: 10, pct: 0 },
          technical: {
            indicators: { atr: { atr: 0.2 } },
          },
        },
      },
    },
  }, now)

  assert.equal(entry.advice.reviewCycle.configuredIntervalMin, 30)
  assert.equal(entry.advice.reviewCycle.intervalMin, 5)
  assert.equal(entry.advice.reviewCycle.nextReviewAt, now + 5 * 60000)
})

test('板块前排机会或资金背离会压缩自动复核间隔', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const entry = buildAdviceCacheEntry(null, {
    mode: 'hold_advice',
    reviewIntervalMin: 15,
    advice: { action: '持有' },
    meta: {
      evidenceSnapshot: {
        evidence: {
          quote: { price: 10, pct: 0.8 },
          technical: { indicators: { atr: { atr: 0.2 } } },
          funds: {
            mainNetYi: -0.8,
            retailNetYi: 1.2,
            retailFlow: { relation: 'main_out_retail_in' },
          },
          decisionSignals: {
            sectorOpportunity: {
              probeEligible: true,
              sector: { actionability: 'LAYOUT' },
              stock: { role: 'leader', mainInflow: 1.5 },
            },
          },
        },
      },
    },
  }, now)

  assert.equal(entry.advice.reviewCycle.intervalMin, 5)
  assert.match(
    entry.advice.reviewCycle.riskReasons.join('、'),
    /板块|主力|小单|资金/,
  )
})

test('午间到期的复核顺延到下午开盘', () => {
  const now = new Date('2026-08-10T03:25:00Z').getTime()

  assert.equal(
    nextAdviceReviewAt({ now, mode: 'hold_advice', intervalMin: 15 }),
    new Date('2026-08-10T05:00:00Z').getTime(),
  )
})

test('收盘后到期的复核顺延到下一交易日开盘', () => {
  const now = new Date('2026-08-14T06:55:00Z').getTime()

  assert.equal(
    nextAdviceReviewAt({ now, mode: 'hold_advice', intervalMin: 15 }),
    new Date('2026-08-17T01:30:00Z').getTime(),
  )
})

test('建议缓存记录连续复核责任链', () => {
  const firstAt = new Date('2026-08-10T02:00:00Z').getTime()
  const first = buildAdviceCacheEntry(null, {
    mode: 'hold_advice',
    advice: {
      action: '持有',
      continuity: { changeType: 'initial' },
    },
  }, firstAt)
  const secondAt = new Date('2026-08-10T02:15:00Z').getTime()
  const second = buildAdviceCacheEntry(first, {
    mode: 'hold_advice',
    advice: {
      action: '减仓',
      continuity: { changeType: 'reverse' },
    },
  }, secondAt)

  assert.equal(first.advice.reviewCycle.sequence, 1)
  assert.equal(first.advice.reviewCycle.reviewedAt, firstAt)
  assert.equal(first.advice.reviewCycle.nextReviewAt, firstAt + 15 * 60000)
  assert.equal(second.advice.reviewCycle.sequence, 2)
  assert.equal(second.advice.reviewCycle.previousAction, '持有')
  assert.equal(second.advice.reviewCycle.changeType, 'reverse')
  assert.equal(adviceReviewDue(second, second.advice.reviewCycle.nextReviewAt - 1), false)
  assert.equal(adviceReviewDue(second, second.advice.reviewCycle.nextReviewAt), true)
})

test('复核回执随建议持久化并限制展示字段长度', () => {
  const entry = buildAdviceCacheEntry(null, {
    mode: 'buy_advice',
    reviewDisposition: 'unchanged',
    reviewReason: '关键交易条件未发生实质变化',
    reviewReceipt: {
      checked: ['价格与执行价', '主力与小单资金', '板块与前排资格'],
      changes: ['主力与小单资金结构变化'],
      summary: '关键交易条件未发生实质变化',
    },
    advice: { action: '观望' },
  }, 1000)

  assert.deepEqual(entry.advice.reviewCycle.receipt, {
    checked: ['价格与执行价', '主力与小单资金', '板块与前排资格'],
    changes: ['主力与小单资金结构变化'],
    summary: '关键交易条件未发生实质变化',
  })
})

test('复核事件队列随回执持久化且只保留安全字段', () => {
  const entry = buildAdviceCacheEntry(null, {
    mode: 'hold_advice',
    reviewDisposition: 'material-change',
    reviewReason: '板块状态发生变化',
    reviewReceipt: {
      checked: ['板块与前排资格'],
      changes: ['板块方向或前排资格变化'],
      summary: '板块状态发生变化',
      eventQueue: [{
        schemaVersion: 'advice-review-event.v1',
        kind: 'SECTOR_ROLE',
        priority: 2,
        reason: '板块状态或个股前排资格发生变化',
        requiresLlm: false,
        deterministicAction: 'STRUCTURAL_EXIT_CHECK',
        unsafe: '不应持久化',
      }],
    },
    advice: { action: '持有' },
  }, 1000)

  assert.deepEqual(entry.advice.reviewCycle.receipt.eventQueue, [{
    schemaVersion: 'advice-review-event.v1',
    kind: 'SECTOR_ROLE',
    priority: 2,
    reason: '板块状态或个股前排资格发生变化',
    requiresLlm: false,
    deterministicAction: 'STRUCTURAL_EXIT_CHECK',
  }])
})

test('军师正文暂缺时也安排下次重试，避免每5分钟重复调用', () => {
  const now = new Date('2026-08-10T02:00:00Z').getTime()
  const entry = buildAdviceCacheEntry(null, {
    mode: 'buy_advice',
    result: { score: 61 },
    advice: null,
  }, now)

  assert.equal(entry.reviewCycle.changeType, 'unavailable')
  assert.equal(entry.reviewCycle.nextReviewAt, now + 30 * 60000)
  assert.equal(adviceReviewDue(entry, now + 5 * 60000), false)
})

test('单股持续复核默认开启且可独立关闭后再开启', () => {
  const disabled = setAdviceReviewEnabled({}, '600000', false, 1000)

  assert.equal(isAdviceReviewEnabled({}, '600000'), true)
  assert.equal(isAdviceReviewEnabled(disabled, '600000'), false)
  assert.equal(isAdviceReviewEnabled(disabled, '000001'), true)
  assert.deepEqual(disabled['advReview.disabledCodes'], ['600000'])
  assert.equal(disabled['advAuto.configUpdatedAt'], 1000)

  const enabled = setAdviceReviewEnabled(disabled, '600000', true, 2000)
  assert.equal(isAdviceReviewEnabled(enabled, '600000'), true)
  assert.deepEqual(enabled['advReview.disabledCodes'], [])
})
