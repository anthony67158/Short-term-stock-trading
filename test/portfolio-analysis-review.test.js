import test from 'node:test'
import assert from 'node:assert/strict'

import {
  markPortfolioAnalysisReviewCompleted,
  markPortfolioAnalysisReviewFailed,
  markPortfolioAnalysisReviewQueued,
  portfolioAnalysisReviewConfig,
  portfolioAnalysisReviewDeepMode,
  portfolioAnalysisReviewDue,
  setPortfolioAnalysisReviewEnabled,
} from '../shared/portfolioAnalysisReviewPolicy.js'

const MORNING = Date.UTC(2026, 7, 17, 2, 0)

function dataWithLatest() {
  return {
    portfolioAnalysisLatest: {
      id: 'portfolio_1',
      generatedAt: MORNING - 60000,
      fingerprint: 'same-account',
      result: {
        ok: true,
        analysis: {
          headline: '已有诊断',
        },
      },
    },
  }
}

test('持仓自动复核默认关闭且开启后按60分钟到期', () => {
  const data = dataWithLatest()

  assert.equal(portfolioAnalysisReviewConfig(data).enabled, false)
  setPortfolioAnalysisReviewEnabled(data, true, MORNING)
  const config = portfolioAnalysisReviewConfig(data)

  assert.equal(config.enabled, true)
  assert.equal(config.intervalMin, 60)
  assert.equal(config.nextReviewAt, MORNING + 60 * 60000)
  assert.equal(
    portfolioAnalysisReviewDue(data, {
      now: MORNING + 59 * 60000,
      fingerprint: 'same-account',
    }),
    false,
  )
  assert.equal(
    portfolioAnalysisReviewDue(data, {
      now: MORNING + 60 * 60000,
      fingerprint: 'same-account',
    }),
    true,
  )
})

test('上次深度分析靠无思考恢复后自动复核直接使用稳定模式', () => {
  const data = {
    portfolioAnalysisLatest: {
      deepMode: true,
      result: {
        meta: {
          modelRecovered: true,
          effectiveDeepMode: false,
        },
      },
    },
  }

  assert.equal(portfolioAnalysisReviewDeepMode(data), false)

  delete data.portfolioAnalysisLatest.result.meta.effectiveDeepMode
  data.portfolioAnalysisLatest.result.meta.primaryFailureCode = 'timeout'
  assert.equal(portfolioAnalysisReviewDeepMode(data), false)

  data.portfolioAnalysisLatest.result.meta.modelRecovered = false
  data.portfolioAnalysisLatest.result.meta.effectiveDeepMode = true
  assert.equal(portfolioAnalysisReviewDeepMode(data), false)
})

test('交易账本变化可提前复核但活动任务始终防重', () => {
  const data = dataWithLatest()
  setPortfolioAnalysisReviewEnabled(data, true, MORNING)

  assert.equal(
    portfolioAnalysisReviewDue(data, {
      now: MORNING + 5 * 60000,
      fingerprint: 'changed-account',
    }),
    true,
  )
  data.portfolioAnalysisJob = {
    id: 'portfolio_2',
    status: 'running',
  }
  assert.equal(
    portfolioAnalysisReviewDue(data, {
      now: MORNING + 5 * 60000,
      fingerprint: 'changed-account',
    }),
    false,
  )
})

test('休市期间账本变化不会立即触发付费复核', () => {
  const data = dataWithLatest()
  setPortfolioAnalysisReviewEnabled(data, true, MORNING)
  const afterClose = Date.UTC(2026, 7, 17, 8, 0)

  assert.equal(
    portfolioAnalysisReviewDue(data, {
      now: afterClose,
      fingerprint: 'changed-account',
    }),
    false,
  )
})

test('自动复核排队完成后记录次数与下一次复核时间', () => {
  const data = dataWithLatest()
  setPortfolioAnalysisReviewEnabled(data, true, MORNING)
  markPortfolioAnalysisReviewQueued(data, MORNING + 60 * 60000)
  markPortfolioAnalysisReviewCompleted(data, {
    now: MORNING + 70 * 60000,
    fingerprint: 'new-account',
    source: 'review',
  })
  const config = portfolioAnalysisReviewConfig(data)

  assert.equal(config.lastQueuedAt, MORNING + 60 * 60000)
  assert.equal(config.lastCompletedAt, MORNING + 70 * 60000)
  assert.equal(config.lastFingerprint, 'new-account')
  assert.equal(config.reviewCount, 1)
  assert.ok(config.nextReviewAt > config.lastCompletedAt)
})

test('自动复核失败后至少退避30分钟避免高频付费重试', () => {
  const data = dataWithLatest()
  setPortfolioAnalysisReviewEnabled(data, true, MORNING)
  markPortfolioAnalysisReviewQueued(
    data,
    MORNING + 60 * 60000,
    'changed-account',
  )
  markPortfolioAnalysisReviewFailed(data, MORNING + 60 * 60000)
  const config = portfolioAnalysisReviewConfig(data)

  assert.ok(config.nextReviewAt >= MORNING + 90 * 60000)
  assert.equal(
    portfolioAnalysisReviewDue(data, {
      now: MORNING + 61 * 60000,
      fingerprint: 'changed-account',
    }),
    false,
  )
})
