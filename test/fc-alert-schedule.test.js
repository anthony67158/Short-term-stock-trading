import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { __test as cronAlert } from '../api/cron_alert.js'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('盯盘预警由FC北京时间交易时段触发且GitHub定时拨测已移除', () => {
  const config = read('s.yaml')
  const schedules = [
    ['alert-market-am-open', 'CRON_TZ=Asia/Shanghai 0 30-59 9 * * 1-5'],
    ['alert-market-am-core', 'CRON_TZ=Asia/Shanghai 0 * 10 * * 1-5'],
    ['alert-market-am-close', 'CRON_TZ=Asia/Shanghai 0 0-30 11 * * 1-5'],
    ['alert-market-pm-core', 'CRON_TZ=Asia/Shanghai 0 * 13-14 * * 1-5'],
    ['alert-market-pm-close', 'CRON_TZ=Asia/Shanghai 0 0 15 * * 1-5'],
  ]

  for (const [name, cron] of schedules) {
    assert.ok(config.includes(`- triggerName: ${name}`), `缺少FC触发器 ${name}`)
    assert.ok(config.includes(`cronExpression: "${cron}"`), `缺少调度表达式 ${cron}`)
  }
  assert.equal(
    existsSync(new URL('.github/workflows/cron-alert.yml', root)),
    false,
  )
})

test('云端Judge按时间片轮转账号并在截止时间前停止启动新调用', () => {
  const accounts = [{ nick: 'a' }, { nick: 'b' }, { nick: 'c' }]

  assert.deepEqual(
    cronAlert.rotateAccounts(accounts, 1).map((item) => item.nick),
    ['b', 'c', 'a'],
  )
  assert.equal(cronAlert.hasJudgeBudget(10000, 1000, 8000), true)
  assert.equal(cronAlert.hasJudgeBudget(10000, 2500, 8000), false)
})

test('午间与收盘自动复盘使用FC重复触发以支持失败续跑', () => {
  const config = read('s.yaml')
  const schedules = [
    ['review-noon-open', 'CRON_TZ=Asia/Shanghai 0 35,50 11 * * 1-5'],
    ['review-noon-core', 'CRON_TZ=Asia/Shanghai 0 5,20,35,50 12 * * 1-5'],
    ['review-close-open', 'CRON_TZ=Asia/Shanghai 0 5,20,35,50 15 * * 1-5'],
    ['review-close-late', 'CRON_TZ=Asia/Shanghai 0 5,20,35,50 16 * * 1-5'],
  ]

  for (const [name, cron] of schedules) {
    assert.ok(config.includes(`- triggerName: ${name}`), `缺少FC触发器 ${name}`)
    assert.ok(config.includes(`cronExpression: "${cron}"`), `缺少调度表达式 ${cron}`)
  }
})

test('板块前瞻每五分钟唤醒且具体时间由OSS设置决定', () => {
  const config = read('s.yaml')
  const server = read('server.js')

  assert.ok(config.includes('- triggerName: sector-forecast-due-timer'))
  assert.ok(config.includes('cronExpression: "@every 5m"'))
  assert.match(server, /sectorForecastTimerBody\(/)
  assert.match(server, /sectorForecastBody[\s\S]*'sector_forecast'/)
})

test('策略日报每五分钟检查账号计划并路由到独立日报Worker', () => {
  const config = read('s.yaml')
  const server = read('server.js')

  assert.ok(config.includes('- triggerName: daily-report-schedule-timer'))
  assert.match(server, /dailyReportTimerBody\(/)
  assert.match(server, /dailyReportWorkerBody\(/)
  assert.match(server, /dailyReportBody[\s\S]*'cron_daily_report'/)
})
