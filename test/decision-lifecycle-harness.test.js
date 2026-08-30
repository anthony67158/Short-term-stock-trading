import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  runDecisionLifecycleHarnessCase,
} from '../harness/adapters/decision-lifecycle.mjs'
import { runHarnessCli } from '../harness/run.mjs'

const caseSet = JSON.parse(readFileSync(
  new URL(
    '../harness/cases/decision-lifecycle.json',
    import.meta.url,
  ),
  'utf8',
))

test('假股票决策链覆盖买入加仓减仓等待与异常恢复', () => {
  assert.equal(caseSet.cases.length, 13)
  const outcomes = caseSet.cases.map(
    (item) => item.expect.finalOutcome,
  )
  const alertKinds = caseSet.cases.map(
    (item) => item.expect.alertKind,
  )
  assert.ok(outcomes.includes('立即买入'))
  assert.ok(outcomes.includes('立即加仓'))
  assert.ok(outcomes.includes('立即减仓'))
  assert.ok(outcomes.includes('维持观望'))
  assert.ok(alertKinds.includes('BUY'))
  assert.ok(alertKinds.includes('REDUCE'))
  assert.ok(alertKinds.includes('REVIEW_ONLY'))
  assert.equal(
    caseSet.cases.every((item) =>
      /^99\d{4}$/.test(item.input.security.code)
      && /星河|云岭|澄海|青川|凌峰|海岳|远川|沧澜|瀚星|松岳|岳海/.test(
        item.input.security.name,
      )
    ),
    true,
  )
})

test('每条离线决策链按声明采样次数重复执行仍保持确定结果', async () => {
  for (const testCase of caseSet.cases) {
    const runs = []
    const samples = Number(testCase.sampling_count) || 5
    for (let index = 0; index < samples; index++) {
      const result = await runDecisionLifecycleHarnessCase(testCase)
      assert.equal(
        result.checks.every((item) => item.passed),
        true,
        `${testCase.id} 第${index + 1}次回放失败`,
      )
      runs.push(JSON.stringify(result.output))
    }
    assert.equal(
      new Set(runs).size,
      1,
      `${testCase.id} 多次回放输出不稳定`,
    )
  }
})

test('统一Harness入口可独立执行完整决策链套件', async () => {
  const execution = await runHarnessCli([
    '--suite',
    'decision-lifecycle',
    '--no-baseline',
    '--no-write',
  ])

  assert.equal(execution.exitCode, 0)
  assert.equal(execution.run.summary.total, 13)
  assert.equal(execution.run.summary.passed, 13)
  assert.equal(execution.run.summary.overall, 1)
})
