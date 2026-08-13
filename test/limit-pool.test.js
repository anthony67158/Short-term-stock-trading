import test from 'node:test'
import assert from 'node:assert/strict'

import {
  limitPoolRequest,
  normalizeLimitPool,
} from '../api/_limit_pool.js'

test('涨停、跌停和炸板池使用各自有效的东方财富排序字段', () => {
  const zt = limitPoolRequest('zt', '20260813', 1)
  const dt = limitPoolRequest('dt', '20260813', 1)
  const zb = limitPoolRequest('zb', '20260813', 1)

  assert.match(zt, /getTopicZTPool/)
  assert.match(zt, /sort=fbt%3Aasc/)
  assert.match(dt, /getTopicDTPool/)
  assert.match(dt, /sort=fund%3Adesc/)
  assert.match(zb, /getTopicZBPool/)
  assert.match(zb, /sort=zbc%3Adesc/)
})

test('池子总数优先使用权威tc且保留炸板列表', () => {
  const result = normalizeLimitPool('zb', {
    data: {
      tc: 36,
      qdate: 20260813,
      pool: [
        { c: '000001', n: '示例', p: 10000, zdp: 7, zbc: 3, hs: 10 },
      ],
    },
  })

  assert.equal(result.total, 36)
  assert.equal(result.list.length, 1)
  assert.equal(result.list[0].breakTimes, 3)
})
