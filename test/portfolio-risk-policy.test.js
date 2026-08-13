import test from 'node:test'
import assert from 'node:assert/strict'

import { applyPortfolioRiskPolicy } from '../shared/portfolioRiskPolicy.js'

test('弱市且账户接近满仓时新的买入建议被硬性降级为观望', () => {
  const { result, risk } = applyPortfolioRiskPolicy({
    mode: 'buy_advice',
    result: {
      action: '立即买入',
      tier: 'now',
      tone: 'red',
      buyPrice: 20,
      planQty: 2,
      planQtyNum: 2,
      planAmount: 4000,
      actionPlan: '立即买入2手',
    },
    payload: {
      account: {
        totalAssets: 80000,
        cash: 3000,
        position: 96.2,
      },
      marketEnv: { score: 28, weak: true, level: '极弱' },
      counterTrend: { isStrong: false },
      quant: { highConfSignal: { fired: false } },
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.planQty, 0)
  assert.equal(result.planAmount, 0)
  assert.equal(risk.blocked, true)
  assert.match(risk.reasons.join(' '), /仓位|现金|弱市/)
})

test('弱市只有逆势强势与高把握信号同时成立才允许小仓买入', () => {
  const { result, risk } = applyPortfolioRiskPolicy({
    mode: 'buy_advice',
    result: {
      action: '小仓试错',
      tier: 'probe',
      buyPrice: 20,
      planQty: 1,
      planQtyNum: 1,
      planAmount: 2000,
    },
    payload: {
      account: {
        totalAssets: 80000,
        cash: 40000,
        position: 50,
      },
      marketEnv: { score: 35, weak: true, level: '偏弱' },
      counterTrend: { isStrong: true },
      quant: { highConfSignal: { fired: true } },
    },
  })

  assert.equal(result.action, '小仓试错')
  assert.equal(result.planQty, 1)
  assert.equal(risk.blocked, false)
})

test('市场环境缺失时不伪造弱市理由阻止正常小仓买入', () => {
  const { result, risk } = applyPortfolioRiskPolicy({
    mode: 'buy_advice',
    result: {
      action: '小仓试错',
      tier: 'probe',
      buyPrice: 20,
      planQty: 1,
      planQtyNum: 1,
      planAmount: 2000,
    },
    payload: {
      account: {
        totalAssets: 80000,
        cash: 40000,
        position: 50,
      },
    },
  })

  assert.equal(result.action, '小仓试错')
  assert.equal(risk.blocked, false)
  assert.equal(risk.reasons.some((reason) => /弱市/.test(reason)), false)
})

test('继续持有时收盘已跌破止损必须改为退出可卖仓位', () => {
  const { result, risk } = applyPortfolioRiskPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      tone: 'red',
      opQty: '无需操作',
      stopPrice: 12,
      targetPrice: 13,
      actionPlan: '继续持有',
    },
    payload: {
      holdQty: 4,
      sellableTodayQty: 3,
      todayQuote: { price: 11.8, live: false },
      account: { totalAssets: 80000, cash: 10000, position: 87.5 },
    },
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.opQty, '减仓3手')
  assert.equal(result.reducePrice, 11.8)
  assert.equal(risk.stopBreached, true)
  assert.match(result.actionPlan, /跌破止损/)
})

test('止损未破且账户风险正常时保留继续持有', () => {
  const { result, risk } = applyPortfolioRiskPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.5,
      targetPrice: 11,
      actionPlan: '继续持有',
    },
    payload: {
      holdQty: 2,
      sellableTodayQty: 2,
      todayQuote: { price: 10.2, live: false },
      account: { totalAssets: 80000, cash: 30000, position: 62.5 },
    },
  })

  assert.equal(result.action, '持有')
  assert.equal(risk.stopBreached, false)
})

test('弱市非逆势强票下跌超过2%时继续持有改为部分减仓', () => {
  const { result, risk } = applyPortfolioRiskPolicy({
    mode: 'hold_advice',
    result: {
      action: '持有',
      stopPrice: 9.2,
      targetPrice: 11,
      actionPlan: '继续持有',
    },
    payload: {
      holdQty: 6,
      sellableTodayQty: 6,
      todayQuote: { price: 9.7, pct: -3.2, live: true },
      marketEnv: { score: 36, weak: true, level: '偏弱' },
      counterTrend: { isStrong: false },
      account: { totalAssets: 80000, cash: 20000, position: 75 },
    },
  })

  assert.equal(result.action, '减仓')
  assert.equal(result.opQty, '减仓2手')
  assert.equal(result.reducePrice, 9.7)
  assert.equal(risk.weakMarketDefense, true)
})
