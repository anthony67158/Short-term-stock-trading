import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isQuantResultForVersion,
  normalizeQuantModelVersion,
  quantModelLabel,
} from '../shared/modelVersion.js'

test('旧量化模型设置统一迁移到默认日线辅助模型', () => {
  assert.equal(normalizeQuantModelVersion(), 'default')
  assert.equal(normalizeQuantModelVersion('default'), 'default')
  assert.equal(normalizeQuantModelVersion('v2'), 'default')
  assert.equal(normalizeQuantModelVersion('v2.1'), 'default')
  assert.equal(normalizeQuantModelVersion('unknown'), 'default')
  assert.equal(quantModelLabel(), '36因子日线辅助模型')
})

test('旧Transformer结果不能冒充当前辅助模型结果', () => {
  assert.equal(isQuantResultForVersion({
    ok: true,
    quantModelVersion: 'default',
    quant: { score: 61 },
  }), true)
  assert.equal(isQuantResultForVersion({
    ok: true,
    quant: { score: 61 },
  }), true)
  assert.equal(isQuantResultForVersion({
    ok: true,
    quantModelVersion: 'v2',
    quant: { score: 72 },
  }), false)
  assert.equal(isQuantResultForVersion({
    ok: true,
    quant: {
      score: 68,
      selectedModelVersion: 'v2.1',
    },
  }), false)
  assert.equal(isQuantResultForVersion({
    ok: false,
    quant: null,
  }), false)
})
