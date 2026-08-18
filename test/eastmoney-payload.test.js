import test from 'node:test'
import assert from 'node:assert/strict'

import { parseEastmoneyPayload } from '../api/_lib.js'

test('东方财富响应解析同时支持JSON与JSONP', () => {
  assert.deepEqual(
    parseEastmoneyPayload('{"code":0,"data":{"name":"创新药"}}'),
    { code: 0, data: { name: '创新药' } },
  )
  assert.deepEqual(
    parseEastmoneyPayload(
      'conceptKline({"code":0,"data":{"name":"创新药"}});',
    ),
    { code: 0, data: { name: '创新药' } },
  )
})

test('东方财富响应解析拒绝空内容与非JSONP脚本', () => {
  assert.throws(() => parseEastmoneyPayload(''), /empty payload/)
  assert.throws(
    () => parseEastmoneyPayload('alert("bad")'),
    /invalid payload/,
  )
})
