import test from 'node:test'
import assert from 'node:assert/strict'

import {
  currentQuantModelVersion,
  quantModelQuery,
  withQuantModelPayload,
} from '../src/quantModel.js'
import { planStore } from '../src/planStore.js'

test('量化查询与AI载荷只使用默认日线辅助模型', () => {
  assert.equal(quantModelQuery('default'), '&model=default')
  assert.equal(quantModelQuery('v2'), '&model=default')
  assert.equal(quantModelQuery('v2.1'), '&model=default')
  assert.equal(
    withQuantModelPayload({ source: 'stock-pick' }, 'default').quantModelVersion,
    'default',
  )
  assert.equal(
    withQuantModelPayload({ source: 'stock-pick' }, 'v2').quantModelVersion,
    'default',
  )
  assert.equal(
    withQuantModelPayload({ source: 'stock-pick' }, 'v2.1').quantModelVersion,
    'default',
  )
})

test('未知模型版本按默认生产模型处理', () => {
  assert.equal(quantModelQuery('unknown'), '&model=default')
  assert.equal(
    withQuantModelPayload({}, 'unknown').quantModelVersion,
    'default',
  )
})

test('旧账号模型设置在首次读取时写回default', () => {
  const originalGetSetting = planStore.getSetting
  const originalSetSetting = planStore.setSetting
  const writes = []
  planStore.getSetting = () => 'v2.1'
  planStore.setSetting = (key, value) => writes.push([key, value])
  try {
    assert.equal(currentQuantModelVersion(), 'default')
    assert.deepEqual(writes, [['quantModelVersion', 'default']])
  } finally {
    planStore.getSetting = originalGetSetting
    planStore.setSetting = originalSetSetting
  }
})
