import test from 'node:test'
import assert from 'node:assert/strict'

import {
  quantModelQuery,
  withQuantModelPayload,
} from '../src/quantModel.js'

test('量化查询与AI载荷使用同一个显式模型版本', () => {
  assert.equal(quantModelQuery('default'), '&model=default')
  assert.equal(quantModelQuery('v2'), '&model=v2')
  assert.equal(quantModelQuery('v2.1'), '&model=v2.1')
  assert.equal(
    withQuantModelPayload({ source: 'stock-pick' }, 'default').quantModelVersion,
    'default',
  )
  assert.equal(
    withQuantModelPayload({ source: 'stock-pick' }, 'v2').quantModelVersion,
    'v2',
  )
  assert.equal(
    withQuantModelPayload({ source: 'stock-pick' }, 'v2.1').quantModelVersion,
    'v2.1',
  )
})

test('未知模型版本按默认生产模型处理', () => {
  assert.equal(quantModelQuery('unknown'), '&model=default')
  assert.equal(
    withQuantModelPayload({}, 'unknown').quantModelVersion,
    'default',
  )
})
