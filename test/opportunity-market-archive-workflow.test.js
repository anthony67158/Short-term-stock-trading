import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(
  new URL('../.github/workflows/daily-retrain.yml', import.meta.url),
  'utf8',
)

test('每日归档上一完整交易日并只从Actions Secret读取凭证', () => {
  const job = workflow.split('  market-data-archive:')[1]
    ?.split('\n  sector-retrain:')[0] || ''

  assert.match(job, /needs: verify/)
  assert.match(job, /timeout-minutes: 35/)
  assert.match(job, /TUSHARE_TOKEN: \$\{\{ secrets\.TUSHARE_TOKEN \}\}/)
  assert.match(job, /archive_tushare_market_day\.py/)
  assert.match(job, /--universe-size 1000/)
  assert.match(job, /--max-per-min 120/)
  assert.doesNotMatch(job, /token=[a-f0-9]{20,}/i)
})

test('机会训练先合并并压实增量样本再训练', () => {
  const job = workflow.split('  opportunity-retrain:')[1]
    ?.split('\n  market-data-archive:')[0] || ''
  const collect = job.indexOf('collect_opportunity_outcomes.py')
  const compact = job.indexOf('publish_opportunity_history.py')
  const train = job.indexOf('train_opportunity_score.py')

  assert.ok(collect >= 0)
  assert.ok(compact > collect)
  assert.ok(train > compact)
})

test('市场归档合同进入每日重训验证门禁', () => {
  assert.match(workflow, /tests\/test_opportunity_market_archive\.py/)
  assert.match(workflow, /tests\/test_archive_tushare_market_day\.py/)
})
