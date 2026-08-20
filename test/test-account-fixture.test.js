import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/comprehensive-test-account.json', import.meta.url),
  'utf8',
))

test('测试账号假数据覆盖系统能力且不会自动触发付费任务', () => {
  assert.equal(fixture.fixtureProfile, 'system-capability-demo.v1')
  assert.ok(fixture.account?.totalAssets > 0)
  assert.ok(fixture.account?.cash > 0)
  assert.ok(fixture.holding.length >= 3)
  assert.ok(fixture.holding.some((item) => item.tRealizedPnl > 0))
  assert.ok(fixture.plan.length >= 3)

  const tradeTypes = new Set(fixture.closed.map((item) => item.type))
  assert.ok(tradeTypes.has('BUY'))
  assert.ok(tradeTypes.has('SELL'))
  assert.ok(tradeTypes.has('T'))

  assert.ok(Object.values(fixture.advice).some(
    (entry) => entry.mode === 'hold_advice',
  ))
  assert.ok(Object.values(fixture.advice).some(
    (entry) => entry.mode === 'buy_advice',
  ))
  assert.ok(fixture.adviceLog.some((item) => item.verified === true))
  assert.ok(fixture.decisionLog.some((item) => item.kind === 'execution'))
  assert.ok(Object.keys(fixture.reviews).length >= 2)

  const alertPhases = new Set(fixture.alerts.map((item) => item.phase))
  assert.ok(alertPhases.has('confirmed'))
  assert.ok(alertPhases.has('invalid'))
  assert.ok(fixture.portfolioAnalysisLatest?.result?.summary)
  assert.ok(fixture.portfolioAnalysisHistory.length >= 1)

  assert.equal(fixture.settings['advAuto.holdEnabled'], false)
  assert.equal(fixture.settings['advAuto.watchEnabled'], false)
  assert.deepEqual(
    fixture.settings['advReview.disabledCodes'].sort(),
    [...new Set([
      ...fixture.holding.map((item) => item.code),
      ...fixture.plan.map((item) => item.code),
    ])].sort(),
  )
  assert.equal(
    Object.values(fixture.jobs || {}).some((job) =>
      ['queued', 'running'].includes(job?.status)
    ),
    false,
  )
})
