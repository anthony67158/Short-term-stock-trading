import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  quantResultFromAdviceMeta,
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

test('本地建议生成不再独立请求旧口径quantUrl覆盖军师量化', () => {
  assert.doesNotMatch(runnerSource, /fetch\(quantUrl/)
  assert.match(runnerSource, /quantResultFromAdviceMeta\(meta/)
})
