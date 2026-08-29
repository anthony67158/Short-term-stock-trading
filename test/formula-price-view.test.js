import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFormulaPriceExplanation,
} from '../src/formulaPriceView.js'

test('未命中公式时明确说明已运行并展示最接近公式的失败条件', () => {
  const explanation = buildFormulaPriceExplanation({
    formula: {
      mode: 'CLOSE',
      evaluations: [
        {
          formulaId: 'CLOSE_TREND_PULLBACK',
          name: '收盘趋势回踩',
          matched: false,
          blockers: ['MA20仍在向下', '资金承接未确认'],
        },
        {
          formulaId: 'CLOSE_SQUEEZE',
          name: '收盘蓄势突破',
          matched: false,
          blockers: ['布林带尚未收窄', '成交量尚未收敛', '板块方向未确认'],
        },
      ],
    },
    decision: {
      action: 'AVOID',
      formulaId: null,
      blockers: ['当前没有公式形成有效主路径'],
    },
  })

  assert.equal(explanation.computed, true)
  assert.equal(explanation.status, '已完成2条收盘公式检查')
  assert.equal(explanation.formulaName, '收盘趋势回踩')
  assert.equal(explanation.title, '最接近“收盘趋势回踩”，还差2项')
  assert.deepEqual(
    explanation.reasons,
    ['MA20仍在向下', '资金承接未确认'],
  )
  assert.equal(explanation.alternative, '收盘蓄势突破还差3项')
})

test('公式已命中但价格风控失败时优先展示最终阻断原因', () => {
  const explanation = buildFormulaPriceExplanation({
    formula: {
      mode: 'INTRADAY',
      evaluations: [{
        formulaId: 'INTRADAY_VWAP_PULLBACK',
        name: '盘中回踩承接',
        matched: true,
        blockers: [],
      }],
    },
    decision: {
      action: 'AVOID',
      formulaId: null,
      blockers: ['公式价位无法形成至少1.8:1的盈亏比'],
    },
  })

  assert.equal(explanation.computed, true)
  assert.equal(explanation.title, '公式已命中，但价格风控未通过')
  assert.deepEqual(
    explanation.reasons,
    ['公式价位无法形成至少1.8:1的盈亏比'],
  )
})

test('没有公式评估结果时明确区分为尚未完成计算', () => {
  const explanation = buildFormulaPriceExplanation({})

  assert.equal(explanation.computed, false)
  assert.equal(explanation.status, '尚未完成公式计算')
  assert.equal(explanation.title, '暂时无法判断')
})
