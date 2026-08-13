import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

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
