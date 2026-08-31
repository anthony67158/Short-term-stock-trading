import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  quantResultFromAdviceMeta,
  restoreAdviceEntryQuantEvidence,
} from '../shared/adviceQuantResult.js'

const runnerSource = fs.readFileSync(
  new URL('../src/adviceRunner.js', import.meta.url),
  'utf8',
)

test('建议缓存采用军师本轮实际使用的量化结果', () => {
  const result = quantResultFromAdviceMeta({
    quantResult: {
      score: 72,
      asOf: '2026-08-19',
      inputAsOf: '2026-08-19 14:35:00',
      inputSource: 'completed-5m-aggregated',
    },
  }, 10.5)

  assert.equal(result.score, 72)
  assert.equal(result.inputAsOf, '2026-08-19 14:35:00')
  assert.equal(result.price, 10.5)
})

test('旧到价复核从历史轨迹恢复量化展示并移除假缺失提示', () => {
  const restored = restoreAdviceEntryQuantEvidence({
    result: null,
    advice: {
      action: '观望',
      decisionPlan: {
        schemaVersion: 'decision-plan.v2',
        actionability: 'WATCH',
        evidenceIssues: [{
          source: 'quant',
          label: '量化预测',
          status: 'SKIPPED',
          reason: '依赖条件未满足，本轮未执行（TRIGGERED_REVIEW_REUSE_PREVIOUS）',
        }, {
          source: 'news',
          label: '消息面',
          status: 'EMPTY',
          reason: '接口已响应，但没有返回可用数据',
        }],
      },
    },
    meta: {
      quantResult: null,
    },
    trail: [{
      action: '观望',
      shortHorizonTactical: {
        quant: {
          selectedModelVersion: 'default',
          score: 69,
          direction: '上涨',
          upProb: 59,
          inputAsOf: '2026-08-13T02:20:00.000Z',
        },
      },
    }],
  })

  assert.equal(restored.result.score, 69)
  assert.equal(restored.meta.quantResult.score, 69)
  assert.ok(restored.advice.quantContext)
  assert.deepEqual(
    restored.advice.decisionPlan.evidenceIssues.map((item) => item.source),
    ['news'],
  )
  assert.equal(restored.advice.decisionPlan.actionability, 'WATCH')
})

test('本地建议生成不再独立请求旧口径quantUrl覆盖军师量化', () => {
  assert.doesNotMatch(runnerSource, /fetch\(quantUrl/)
  assert.match(runnerSource, /quantResultFromAdviceMeta\(meta/)
})

test('本地建议完成后立即回传生成耗时而不是等待缓存重载', () => {
  assert.match(
    runnerSource,
    /results\.set\(code,\s*\{[\s\S]*generationMetrics,[\s\S]*cachedAt,/,
  )
  assert.match(
    runnerSource,
    /saveAdvice\(code,\s*\{[\s\S]*generationMetrics,/,
  )
})
