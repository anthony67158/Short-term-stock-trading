import {
  nextAdviceReviewAt,
} from './adviceReviewPolicy.js'
import {
  isContinuousTrading,
} from './tradingCalendar.js'

export const PORTFOLIO_ANALYSIS_REVIEW_INTERVAL_MIN = 60
const FAILURE_RETRY_MIN = 30

function current(data) {
  return data?.portfolioAnalysisReview
    && typeof data.portfolioAnalysisReview === 'object'
    ? data.portfolioAnalysisReview
    : {}
}

function activeJob(data) {
  return ['queued', 'running'].includes(
    data?.portfolioAnalysisJob?.status,
  )
}

export function portfolioAnalysisReviewConfig(data = {}) {
  const value = current(data)
  return {
    enabled: value.enabled === true,
    intervalMin: PORTFOLIO_ANALYSIS_REVIEW_INTERVAL_MIN,
    status: String(value.status || ''),
    updatedAt: Number(value.updatedAt || 0),
    nextReviewAt: Number(value.nextReviewAt || 0),
    lastQueuedAt: Number(value.lastQueuedAt || 0),
    lastCompletedAt: Number(value.lastCompletedAt || 0),
    lastFailedAt: Number(value.lastFailedAt || 0),
    lastFingerprint: String(value.lastFingerprint || ''),
    lastAttemptFingerprint: String(
      value.lastAttemptFingerprint || '',
    ),
    reviewCount: Math.max(0, Number(value.reviewCount || 0)),
  }
}

export function portfolioAnalysisReviewDeepMode(data = {}) {
  const latest = data?.portfolioAnalysisLatest
  const meta = latest?.result?.meta || {}
  if (
    meta.effectiveDeepMode === false
    || (
      meta.modelRecovered === true
      && ['timeout', 'empty_content', 'invalid_json']
        .includes(meta.primaryFailureCode)
    )
  ) {
    return false
  }
  return latest?.deepMode !== false
}

export function setPortfolioAnalysisReviewEnabled(
  data,
  enabled,
  now = Date.now(),
) {
  const previous = portfolioAnalysisReviewConfig(data)
  const hasLatest = !!data?.portfolioAnalysisLatest?.result
  data.portfolioAnalysisReview = {
    ...previous,
    enabled: enabled === true,
    status: enabled === true ? 'scheduled' : 'disabled',
    updatedAt: now,
    nextReviewAt: enabled === true && hasLatest
      ? nextAdviceReviewAt({
          now,
          intervalMin: PORTFOLIO_ANALYSIS_REVIEW_INTERVAL_MIN,
        })
      : 0,
  }
  return portfolioAnalysisReviewConfig(data)
}

export function portfolioAnalysisReviewDue(
  data,
  {
    now = Date.now(),
    fingerprint = '',
  } = {},
) {
  const config = portfolioAnalysisReviewConfig(data)
  const latest = data?.portfolioAnalysisLatest
  if (
    !config.enabled
    || !latest?.result
    || activeJob(data)
    || !isContinuousTrading(now)
  ) {
    return false
  }
  const currentFingerprint = String(fingerprint || '')
  const changed = !!(
    latest.fingerprint
    && currentFingerprint
    && latest.fingerprint !== currentFingerprint
    && config.lastAttemptFingerprint !== currentFingerprint
  )
  return changed
    || !config.nextReviewAt
    || config.nextReviewAt <= now
}

export function markPortfolioAnalysisReviewQueued(
  data,
  now = Date.now(),
  fingerprint = '',
) {
  const config = portfolioAnalysisReviewConfig(data)
  data.portfolioAnalysisReview = {
    ...config,
    status: 'queued',
    lastQueuedAt: now,
    lastAttemptFingerprint: String(fingerprint || ''),
    nextReviewAt: nextAdviceReviewAt({
      now,
      intervalMin: PORTFOLIO_ANALYSIS_REVIEW_INTERVAL_MIN,
    }),
  }
  return portfolioAnalysisReviewConfig(data)
}

export function markPortfolioAnalysisReviewCompleted(
  data,
  {
    now = Date.now(),
    fingerprint = '',
    source = 'manual',
  } = {},
) {
  const config = portfolioAnalysisReviewConfig(data)
  data.portfolioAnalysisReview = {
    ...config,
    status: config.enabled ? 'scheduled' : 'disabled',
    lastCompletedAt: now,
    lastFailedAt: 0,
    lastFingerprint: String(fingerprint || ''),
    lastAttemptFingerprint: String(fingerprint || ''),
    reviewCount: config.reviewCount
      + (source === 'review' ? 1 : 0),
    nextReviewAt: config.enabled
      ? nextAdviceReviewAt({
          now,
          intervalMin: PORTFOLIO_ANALYSIS_REVIEW_INTERVAL_MIN,
        })
      : 0,
  }
  return portfolioAnalysisReviewConfig(data)
}

export function markPortfolioAnalysisReviewFailed(
  data,
  now = Date.now(),
) {
  const config = portfolioAnalysisReviewConfig(data)
  data.portfolioAnalysisReview = {
    ...config,
    status: config.enabled ? 'retry-wait' : 'disabled',
    lastFailedAt: now,
    nextReviewAt: config.enabled
      ? nextAdviceReviewAt({
          now,
          intervalMin: FAILURE_RETRY_MIN,
        })
      : 0,
  }
  return portfolioAnalysisReviewConfig(data)
}
