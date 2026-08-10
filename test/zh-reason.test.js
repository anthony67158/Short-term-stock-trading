import test from 'node:test'
import assert from 'node:assert/strict'

import { zhReasonPiece } from '../api/_zh_reason.js'

test('未知英文思考标题降级为全中文研判提示', () => {
  const output = zhReasonPiece('Assessing catalyst durability and downside asymmetry')

  assert.match(output, /[\u4e00-\u9fff]/)
  assert.equal(/[A-Za-z]{3,}/.test(output), false)
})

test('中英混合思考片段不再残留英文句子', () => {
  const output = zhReasonPiece('正在分析走势。 Reviewing liquidity and catalyst durability')

  assert.match(output, /[\u4e00-\u9fff]/)
  assert.equal(/[A-Za-z]{3,}/.test(output), false)
})

test('常见技术缩写允许保留', () => {
  const output = zhReasonPiece('Checking VWAP and RSI signals')

  assert.match(output, /VWAP/)
  assert.match(output, /RSI/)
  assert.equal(/Checking|signals/.test(output), false)
})
