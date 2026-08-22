import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DAILY_REPORT_SCHEDULE_KEY,
  claimDueDailyReport,
  completeDailyReportRun,
  dailyReportScheduleFromSettings,
  failDailyReportRun,
  mergeDailyReportScheduleSettings,
  normalizeDailyReportSchedule,
} from '../shared/dailyReportSchedule.js'
import {
  processDailyReportAccount,
  scheduleDueDailyReports,
} from '../api/cron_daily_report.js'

const mondayMorning = Date.parse('2026-08-24T00:32:00.000Z')
const mondayNoon = Date.parse('2026-08-24T03:42:00.000Z')
const mondayEvening = Date.parse('2026-08-24T07:22:00.000Z')
const sundayMorning = Date.parse('2026-08-23T00:32:00.000Z')

const enabledSchedule = {
  enabled: true,
  morning: { enabled: true, time: '08:30' },
  noon: { enabled: true, time: '11:40' },
  evening: { enabled: true, time: '15:20' },
  updatedAt: 100,
}

test('日报自动计划校验三个场次的北京时间范围', () => {
  assert.deepEqual(normalizeDailyReportSchedule(enabledSchedule), enabledSchedule)
  assert.throws(
    () => normalizeDailyReportSchedule({
      ...enabledSchedule,
      noon: { enabled: true, time: '09:00' },
    }),
    /午间日报时间必须在11:30-14:55之间/,
  )
})

test('盘前日报每天可运行而午间和收盘只在交易日运行', () => {
  const saturday = {
    [DAILY_REPORT_SCHEDULE_KEY]: enabledSchedule,
  }
  assert.equal(
    claimDueDailyReport({ settings: saturday }, { now: sundayMorning })?.session,
    'morning',
  )

  const sundayNoon = Date.parse('2026-08-23T03:42:00.000Z')
  assert.equal(
    claimDueDailyReport({ settings: saturday }, { now: sundayNoon }),
    null,
  )

  assert.equal(
    claimDueDailyReport(
      { settings: saturday },
      { now: mondayNoon },
    )?.session,
    'noon',
  )
})

test('同一日报场次使用租约和完成记录防止重复生成', () => {
  const data = {
    settings: { [DAILY_REPORT_SCHEDULE_KEY]: enabledSchedule },
  }
  const claim = claimDueDailyReport(data, { now: mondayMorning })
  assert.equal(claim.runKey, '2026-08-24:morning')
  assert.equal(claim.attempt, 1)
  assert.equal(claimDueDailyReport(data, { now: mondayMorning + 60_000 }), null)

  completeDailyReportRun(data, {
    runKey: claim.runKey,
    session: claim.session,
    summary: { text: '盘前摘要' },
    now: mondayMorning + 120_000,
  })
  assert.equal(data.dailyReportAuto.active, null)
  assert.equal(
    data.dailyReportAuto.completed['2026-08-24:morning'],
    mondayMorning + 120_000,
  )
  assert.equal(claimDueDailyReport(data, { now: mondayMorning + 180_000 }), null)
})

test('自动日报失败可在时间窗内有限重试且不会无限消耗模型', () => {
  const data = {
    settings: { [DAILY_REPORT_SCHEDULE_KEY]: enabledSchedule },
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = claimDueDailyReport(data, {
      now: mondayEvening + attempt * 60_000,
    })
    assert.equal(claim.attempt, attempt)
    failDailyReportRun(data, {
      runKey: claim.runKey,
      session: claim.session,
      error: '模型暂时不可用',
      now: mondayEvening + attempt * 60_000 + 1000,
    })
  }
  assert.equal(
    claimDueDailyReport(data, { now: mondayEvening + 5 * 60_000 }),
    null,
  )
  assert.equal(data.dailyReportAuto.latest.status, 'failed')
})

test('跨设备保存按配置更新时间保留较新日报计划', () => {
  const previous = {
    other: true,
    [DAILY_REPORT_SCHEDULE_KEY]: {
      ...enabledSchedule,
      morning: { enabled: true, time: '08:10' },
      updatedAt: 300,
    },
  }
  const incoming = {
    other: false,
    [DAILY_REPORT_SCHEDULE_KEY]: {
      ...enabledSchedule,
      morning: { enabled: true, time: '09:00' },
      updatedAt: 200,
    },
  }

  const merged = mergeDailyReportScheduleSettings(previous, incoming)
  assert.equal(merged.other, false)
  assert.equal(
    dailyReportScheduleFromSettings(merged).morning.time,
    '08:10',
  )
})

test('定时扫描只异步分发到期且有付费权限的日报任务', async () => {
  const eligible = {
    nick: '允许账号',
    status: 'active',
    data: {
      settings: { [DAILY_REPORT_SCHEDULE_KEY]: enabledSchedule },
    },
  }
  const blocked = {
    nick: '未授权账号',
    status: 'active',
    data: {
      settings: { [DAILY_REPORT_SCHEDULE_KEY]: enabledSchedule },
    },
  }
  const dispatched = []
  const result = await scheduleDueDailyReports(
    [eligible, blocked],
    { now: mondayMorning },
    {
      isAuthorized: (account) => account.nick === '允许账号',
      write: async (account) => account,
      dispatch: async (task) => {
        dispatched.push(task)
        return { accepted: true }
      },
    },
  )

  assert.equal(result.claimed, 1)
  assert.equal(result.dispatched, 1)
  assert.deepEqual(dispatched, [{
    nick: '允许账号',
    session: 'morning',
    runKey: '2026-08-24:morning',
  }])
})

test('日报Worker成功后保存摘要并完成场次幂等记录', async () => {
  const account = {
    nick: '测试账号',
    status: 'active',
    data: {
      settings: { [DAILY_REPORT_SCHEDULE_KEY]: enabledSchedule },
      holding: [{ code: '000001', name: '平安银行' }],
      plan: [{ code: '300750', name: '宁德时代', star: true }],
    },
  }
  const claim = claimDueDailyReport(account.data, { now: mondayMorning })
  let saved = null
  const result = await processDailyReportAccount({
    nick: account.nick,
    session: claim.session,
    runKey: claim.runKey,
  }, {
    read: async () => structuredClone(account),
    write: async (value) => { saved = structuredClone(value); return value },
    generate: async (payload) => ({
      ok: true,
      summary: {
        day: '2026-08-24',
        session: 'morning',
        text: `${payload.holdings[0].name}与${payload.watchlist[0].name}`,
      },
    }),
    now: () => mondayMorning + 60_000,
  })

  assert.equal(result.ok, true)
  assert.equal(saved.data.dailyReportAuto.latest.status, 'done')
  assert.equal(saved.data.adviceDailyReport.summary.text, '平安银行与宁德时代')
})
