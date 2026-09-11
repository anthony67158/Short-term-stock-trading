import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(
  new URL('../.github/workflows/daily-retrain.yml', import.meta.url),
  'utf8',
)

test('每日归档只使用QUANT_KEY调用杭州量化FC', () => {
  const job = workflow.split('  market-data-archive:')[1] || ''

  assert.match(job, /needs: verify/)
  assert.match(job, /timeout-minutes: 35/)
  assert.match(job, /QUANT_KEY: \$\{\{ secrets\.QUANT_KEY \}\}/)
  assert.match(job, /X-API-Key: \$QUANT_KEY/)
  assert.match(job, /REUSED_EXISTING_ARCHIVE/)
  assert.doesNotMatch(job, /TUSHARE_TOKEN|archive_tushare/)
  assert.doesNotMatch(job, /token=[a-f0-9]{20,}/i)
})

test('机会训练先合并并压实增量样本再训练', () => {
  const job = workflow.split('  opportunity-retrain:')[1]
    ?.split('\n  market-data-archive:')[0] || ''
  const collect = job.indexOf('collect_opportunity_outcomes.py')
  const compact = job.indexOf('publish_opportunity_history.py')
  const train = job.indexOf('train_opportunity_seed_ensemble.py')

  assert.ok(collect >= 0)
  assert.ok(compact > collect)
  assert.ok(train > compact)
})

test('市场归档合同进入每日重训验证门禁', () => {
  assert.match(workflow, /tests\/test_opportunity_market_archive\.py/)
  assert.match(workflow, /tests\/test_archive_tushare_market_day\.py/)
})

test('V3训练等待市场归档且每日流程不依赖Tushare', () => {
  const job = workflow.split('  opportunity-retrain:')[1]
    ?.split('\n  market-data-archive:')[0] || ''

  assert.match(
    job,
    /if: \$\{\{ always\(\) && needs\.verify\.result == 'success' \}\}/,
  )
  assert.match(job, /needs:\s*\n\s+- verify\s*\n\s+- market-data-archive/)
  assert.doesNotMatch(workflow, /^\s{2}sector-retrain:/m)
  assert.doesNotMatch(workflow, /TUSHARE_TOKEN:/)
})
