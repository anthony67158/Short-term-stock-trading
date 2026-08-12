import test from 'node:test'
import assert from 'node:assert/strict'

import {
  attachAdviceDailyReport,
  createAdviceDailyReportGate,
  isCurrentDailyReportSummary,
} from '../shared/adviceDailyReportPolicy.js'
import {
  collectAdviceDailyReportHoldings,
  ensureAdviceDailyReport,
  failAdviceJobsForDailyReport,
  setAdviceDailyReportPhase,
} from '../api/_advice_daily_report.js'

const NOW = Date.parse('2026-08-12T02:30:00.000Z')
const SUMMARY = {
  day: '2026-08-12',
  session: 'morning',
  sessionCn: '盘前早报',
  text: '今日策略以等待确认、控制仓位为主。',
}

test('当天已有策略日报时直接复用且不重复生成', async () => {
  let generated = 0
  const gate = createAdviceDailyReportGate({ now: () => NOW })

  const result = await gate.ensure({
    existingSummary: SUMMARY,
    getSummary: async () => null,
    generate: async () => {
      generated++
      return { ok: true, summary: SUMMARY }
    },
  })

  assert.equal(result.generated, false)
  assert.equal(result.source, 'account')
  assert.deepEqual(result.summary, SUMMARY)
  assert.equal(generated, 0)
})

test('日报缺失时先生成且并发军师只触发一次日报', async () => {
  let generated = 0
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const gate = createAdviceDailyReportGate({ now: () => NOW })
  const request = () => gate.ensure({
    getSummary: async () => null,
    generate: async () => {
      generated++
      await pending
      return { ok: true, summary: SUMMARY }
    },
  })

  const first = request()
  const second = request()
  release()
  const [left, right] = await Promise.all([first, second])

  assert.equal(generated, 1)
  assert.equal(left.generated, true)
  assert.deepEqual(right.summary, SUMMARY)
})

test('昨天的摘要不会冒充今日日报且无有效摘要时阻断建议', async () => {
  const gate = createAdviceDailyReportGate({ now: () => NOW })
  assert.equal(isCurrentDailyReportSummary({
    ...SUMMARY,
    day: '2026-08-11',
  }, NOW), false)

  await assert.rejects(
    () => gate.ensure({
      existingSummary: { ...SUMMARY, day: '2026-08-11' },
      getSummary: async () => null,
      generate: async () => ({ ok: false, error: '日报模型超时' }),
    }),
    /日报模型超时/,
  )
})

test('云端等待任务展示日报阶段且日报失败后明确终止', () => {
  const data = {
    jobs: {
      '600000': { code: '600000', status: 'queued', phase: '排队中' },
      '000001': { code: '000001', status: 'running', phase: '分析中' },
      '300001': { code: '300001', status: 'done', phase: '完成' },
    },
  }

  setAdviceDailyReportPhase(data, '首次生成：正在准备策略日报', 2000)
  assert.equal(data.jobs['600000'].phase, '首次生成：正在准备策略日报')
  assert.equal(data.jobs['000001'].phase, '首次生成：正在准备策略日报')
  assert.equal(data.jobs['300001'].phase, '完成')

  const failed = failAdviceJobsForDailyReport(
    data,
    '策略日报生成失败：模型超时',
    3000,
  )
  assert.equal(failed, 2)
  assert.equal(data.jobs['600000'].status, 'failed')
  assert.equal(data.jobs['000001'].status, 'failed')
  assert.equal(data.jobs['600000'].error, '策略日报生成失败：模型超时')
  assert.equal(data.jobs['600000'].finishedAt, 3000)
})

test('军师载荷直接携带闸门确认的日报摘要', () => {
  const payload = attachAdviceDailyReport(
    { code: '600000', quantModelVersion: 'v2' },
    SUMMARY,
    NOW,
  )

  assert.deepEqual(payload.dailyReport, SUMMARY)
  assert.equal(payload.code, '600000')
  assert.equal(
    attachAdviceDailyReport(
      { code: '600000' },
      { ...SUMMARY, day: '2026-08-11' },
      NOW,
    ).dailyReport,
    undefined,
  )
})

test('云端首次生成日报时使用账号内去重后的真实持仓', () => {
  const holdings = collectAdviceDailyReportHoldings({
    holding: [
      { code: '600000', name: '浦发银行', qty: 100 },
      { code: '600000', name: '浦发银行', qty: 200 },
      { code: '000001', name: '平安银行', qty: 300 },
      { code: '', name: '无效持仓', qty: 100 },
    ],
  })

  assert.deepEqual(holdings, [
    { code: '600000', name: '浦发银行' },
    { code: '000001', name: '平安银行' },
  ])
})

test('云端日报单飞锁按账号隔离', async () => {
  const date = new Date(Date.now() + 8 * 3600 * 1000)
  const day = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
  let generated = 0
  const generate = (text) => async () => {
    generated++
    return {
      ok: true,
      summary: { ...SUMMARY, day, text },
    }
  }

  const [left, right] = await Promise.all([
    ensureAdviceDailyReport({
      scopeKey: 'account-a',
      getSummary: async () => null,
      generate: generate('账号 A 日报'),
    }),
    ensureAdviceDailyReport({
      scopeKey: 'account-b',
      getSummary: async () => null,
      generate: generate('账号 B 日报'),
    }),
  ])

  assert.equal(generated, 2)
  assert.equal(left.summary.text, '账号 A 日报')
  assert.equal(right.summary.text, '账号 B 日报')
})
