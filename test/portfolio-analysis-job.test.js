import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  completePortfolioAnalysisJob,
  findPortfolioAnalysisHistory,
  failPortfolioAnalysisJob,
  leasePortfolioAnalysisJob,
  listPortfolioAnalysisHistory,
  latestPortfolioAnalysis,
  publicPortfolioAnalysisJob,
  queuePortfolioAnalysisJob,
  updatePortfolioAnalysisJob,
} from '../shared/portfolioAnalysisJob.js'
import {
  buildPortfolioAnalysisWorkerEvent,
} from '../api/_portfolio_analysis_dispatch.js'
import {
  portfolioAnalysisTimerBody,
  portfolioAnalysisWorkerBody,
} from '../api/_advice_timer.js'

const serverlessConfig = readFileSync(
  new URL('../s.yaml', import.meta.url),
  'utf8',
)

test('持仓分析后台任务可排队、防重、领取并持久化阶段进度', () => {
  const data = {}
  const first = queuePortfolioAnalysisJob(data, {
    deepMode: true,
    refresh: false,
  }, 1000)
  const duplicate = queuePortfolioAnalysisJob(data, {
    deepMode: false,
    refresh: true,
  }, 1200)

  assert.equal(first.created, true)
  assert.equal(first.job.status, 'queued')
  assert.equal(first.job.deepMode, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.id, first.job.id)

  const leased = leasePortfolioAnalysisJob(
    data,
    first.job.id,
    2000,
  )
  assert.equal(leased.status, 'running')
  assert.equal(leased.attempts, 1)
  assert.ok(leased.leaseUntil > 2000)

  updatePortfolioAnalysisJob(
    data,
    first.job.id,
    'phase',
    { key: 'market', text: '正在核验市场环境' },
    3000,
  )
  updatePortfolioAnalysisJob(
    data,
    first.job.id,
    'evidence',
    { items: [{ id: 'E1', title: '账户快照' }] },
    3100,
  )
  updatePortfolioAnalysisJob(
    data,
    first.job.id,
    'decision',
    {
      node: {
        key: 'concentration',
        title: '集中度',
        conclusion: '偏高',
      },
    },
    3200,
  )

  assert.equal(data.portfolioAnalysisJob.phaseKey, 'market')
  assert.equal(data.portfolioAnalysisJob.phases.length, 1)
  assert.equal(data.portfolioAnalysisJob.evidence.length, 1)
  assert.equal(data.portfolioAnalysisJob.decisions.length, 1)
})

test('持仓分析后台任务只接受当前任务结果并提供安全公开快照', () => {
  const data = {}
  const { job } = queuePortfolioAnalysisJob(data, {}, 1000)
  leasePortfolioAnalysisJob(data, job.id, 1100)
  const result = {
    ok: true,
    generatedAt: 5000,
    analysis: {
      headline: '降低集中度',
    },
  }

  assert.equal(
    completePortfolioAnalysisJob(data, 'stale-job', result, 5000),
    false,
  )
  assert.equal(
    completePortfolioAnalysisJob(data, job.id, result, 5000),
    true,
  )
  const snapshot = publicPortfolioAnalysisJob(
    data.portfolioAnalysisJob,
  )
  assert.equal(snapshot.status, 'done')
  assert.deepEqual(snapshot.result, result)
  assert.equal(snapshot.leaseUntil, undefined)
  assert.equal(snapshot.cancelRequested, undefined)
})

test('失败的持仓分析任务保留可理解错误且不会覆盖新任务', () => {
  const data = {}
  const { job } = queuePortfolioAnalysisJob(data, {}, 1000)
  leasePortfolioAnalysisJob(data, job.id, 1100)

  assert.equal(
    failPortfolioAnalysisJob(
      data,
      job.id,
      '上游暂不可用',
      2000,
    ),
    true,
  )
  assert.equal(data.portfolioAnalysisJob.status, 'failed')
  assert.equal(data.portfolioAnalysisJob.error, '上游暂不可用')
  assert.equal(
    failPortfolioAnalysisJob(data, 'stale-job', '错误', 2100),
    false,
  )
})

test('FC持仓分析Worker事件与定时恢复事件必须校验内部密钥', () => {
  const event = buildPortfolioAnalysisWorkerEvent(
    '测试账号',
    'portfolio_1000',
    'cron-secret',
  )
  assert.deepEqual(
    portfolioAnalysisWorkerBody(event, 'cron-secret'),
    {
      op: 'worker',
      nick: '测试账号',
      jobId: 'portfolio_1000',
    },
  )
  assert.equal(
    portfolioAnalysisWorkerBody(event, 'wrong-secret'),
    null,
  )
  assert.deepEqual(
    portfolioAnalysisTimerBody({
      triggerName: 'portfolio-analysis-resume-timer',
      payload: 'cron-secret',
    }, 'cron-secret'),
    {
      op: 'resume',
    },
  )
  assert.match(
    serverlessConfig,
    /triggerName:\s*portfolio-analysis-resume-timer/,
  )
})

test('完成结果独立归档且重新生成不会清掉最近分析', () => {
  const data = {}
  const first = queuePortfolioAnalysisJob(data, {}, 1000)
  leasePortfolioAnalysisJob(data, first.job.id, 1100)
  const firstResult = {
    ok: true,
    generatedAt: 5000,
    analysis: {
      headline: '第一次组合诊断',
      positionAssessment: { score: 82 },
    },
  }
  completePortfolioAnalysisJob(
    data,
    first.job.id,
    firstResult,
    5000,
  )

  const second = queuePortfolioAnalysisJob(
    data,
    { refresh: true },
    6000,
  )
  assert.equal(second.job.status, 'queued')
  assert.deepEqual(latestPortfolioAnalysis(data).result, firstResult)
  assert.equal(listPortfolioAnalysisHistory(data).length, 1)
  assert.deepEqual(
    findPortfolioAnalysisHistory(data, first.job.id).result,
    firstResult,
  )
})

test('持仓分析历史只保留最近八次并返回轻量摘要', () => {
  const data = {}
  for (let index = 1; index <= 10; index++) {
    const at = index * 1000
    const { job } = queuePortfolioAnalysisJob(data, {
      source: index % 2 ? 'manual' : 'review',
    }, at)
    leasePortfolioAnalysisJob(data, job.id, at + 1)
    completePortfolioAnalysisJob(data, job.id, {
      ok: true,
      generatedAt: at + 10,
      analysis: {
        headline: `第${index}次诊断`,
        positionAssessment: { score: 70 + index },
      },
    }, at + 10)
  }

  const history = listPortfolioAnalysisHistory(data)
  assert.equal(history.length, 8)
  assert.equal(history[0].headline, '第10次诊断')
  assert.equal(history.at(-1).headline, '第3次诊断')
  assert.equal(history[0].result, undefined)
  assert.equal(
    findPortfolioAnalysisHistory(data, history[0].id)
      .result.analysis.headline,
    '第10次诊断',
  )
})

test('旧版已完成Job在重新生成前自动迁移到保留历史', () => {
  const legacyResult = {
    ok: true,
    generatedAt: 5000,
    analysis: {
      headline: '旧版已完成分析',
    },
  }
  const data = {
    portfolioAnalysisJob: {
      id: 'portfolio_1000',
      status: 'done',
      deepMode: true,
      createdAt: 1000,
      finishedAt: 5000,
      result: legacyResult,
    },
  }

  queuePortfolioAnalysisJob(data, { refresh: true }, 6000)

  assert.deepEqual(latestPortfolioAnalysis(data).result, legacyResult)
  assert.equal(listPortfolioAnalysisHistory(data).length, 1)
})
