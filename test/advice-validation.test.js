import test from 'node:test'
import assert from 'node:assert/strict'

import { reconcileAdviceNumbers } from '../shared/adviceValidation.js'

test('买入建议按现金上限裁剪手数并重算金额与风险收益', () => {
  const { result, issues } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: { account: { cash: 2500 }, todayQuote: { price: 10 } },
    result: {
      action: '立即买入',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 5,
      planAmount: 500,
      riskAmount: '瞎算',
      expReturn: '瞎算',
    },
  })

  assert.equal(result.planQty, 2)
  assert.equal(result.planQtyNum, 2)
  assert.equal(result.planAmount, 2000)
  assert.match(result.riskAmount, /200/)
  assert.match(result.expReturn, /400/)
  assert.equal(issues.includes('买入手数超过可用资金'), true)
})

test('买入价格关系非法时降级观望而不是编造修正价', () => {
  const { result, valid } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: { account: { cash: 100000 } },
    result: {
      action: '立即买入',
      tier: 'now',
      buyPrice: 10,
      stopPrice: 10.5,
      targetPrice: 9.5,
      planQty: 3,
      planAmount: 3000,
    },
  })

  assert.equal(valid, false)
  assert.equal(result.action, '观望')
  assert.equal(result.tier, 'wait')
  assert.equal(result.planQty, 0)
  assert.equal(result.planAmount, 0)
  assert.equal(result.buyPrice, null)
})

test('减仓建议不超过可卖手数并正确表达止损锁盈', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'hold_advice',
    payload: {
      holdCost: 10,
      holdQty: 3,
      sellableTodayQty: 2,
      account: { cash: 5000 },
    },
    result: {
      action: '减仓',
      opQty: '减仓5手',
      reducePrice: 12,
      stopPrice: 11,
      targetPrice: 13,
      opAmount: '100元',
      riskAmount: '-300元',
      newCost: 8,
      actionPlan: '反弹到12元减仓5手，回笼6000元',
    },
  })

  assert.equal(result.opQty, '减仓2手')
  assert.equal(result.opAmount, 2400)
  assert.equal(result.newCost, 10)
  assert.match(result.riskAmount, /仍盈利300元/)
  assert.match(result.actionPlan, /减仓2手/)
  assert.match(result.actionPlan, /回笼2400元/)
})

test('现金不足一手时买入建议降级为观望', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: { account: { cash: 500 } },
    result: {
      action: '立即买入',
      tier: 'now',
      buyPrice: 10,
      stopPrice: 9,
      targetPrice: 12,
      planQty: 1,
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.planQty, 0)
  assert.equal(result.planAmount, 0)
})

test('今日无可卖手数时减仓建议降级为持有', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'hold_advice',
    payload: { holdCost: 10, holdQty: 3, sellableTodayQty: 0 },
    result: {
      action: '减仓',
      opQty: '减仓2手',
      reducePrice: 12,
      stopPrice: 9,
      targetPrice: 13,
      actionPlan: '减仓2手，回笼2400元',
    },
  })

  assert.equal(result.action, '持有')
  assert.equal(result.opQty, '无需操作')
  assert.equal(result.opAmount, 0)
  assert.match(result.actionPlan, /今日无可卖仓位/)
})

test('越过涨跌停价带的模型价格直接作废而不是改造成边界价', () => {
  const { result, issues, valid } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: {
      account: { cash: 100000 },
      todayQuote: {
        price: 10,
        limitDownPrice: 9,
        limitUpPrice: 11,
      },
    },
    result: {
      action: '立即买入',
      buyPrice: 12,
      stopPrice: 9.5,
      targetPrice: 13,
      planQty: 1,
    },
  })

  assert.equal(valid, false)
  assert.equal(result.action, '观望')
  assert.equal(result.buyPrice, null)
  assert.match(issues.join('；'), /买入价高于合法价带/)
  assert.doesNotMatch(issues.join('；'), /下调至/)
})

test('高于现价的买入价只能转为突破观察价', () => {
  const { result, issues } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: {
      account: { cash: 100000 },
      todayQuote: {
        price: 15.44,
        high: 15.69,
        live: true,
      },
      tech: {
        atr: 0.681,
        resistance: 15.69,
      },
    },
    result: {
      action: '立即买入',
      buyPrice: 15.69,
      stopPrice: 15.33,
      targetPrice: 17.16,
      planQty: 2,
      actionPlan: '放量站上15.69元后买入2手',
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.buyPrice, null)
  assert.equal(result.breakoutWatchPrice, 15.69)
  assert.equal(result.stopPrice, null)
  assert.equal(result.targetPrice, null)
  assert.match(result.actionPlan, /突破观察价/)
  assert.match(issues.join('；'), /高于当前价/)
})

test('收盘后买入计划转为下一交易时段盘中观察且不立即执行', () => {
  const { result, issues } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: {
      account: { cash: 100000 },
      todayQuote: {
        price: 15.44,
        low: 14.66,
        live: false,
        phase: '盘后(已收盘)',
      },
      tech: {
        atr: 0.681,
        support: 15.2,
      },
      shortHorizonTactical: {
        actionPolicy: {
          nextSessionPlan: {
            action: 'PROBE',
            actionLabel: '小仓试仓',
            session: 'NEXT_TRADING_DAY',
            sessionLabel: '下一交易日盘中',
            maxPositionPct: 5,
            manualConfirmationOnly: true,
            requiresLiveReview: true,
            trigger: '下一交易日盘中，回踩15.2元确认承接后重新评估',
          },
        },
      },
    },
    result: {
      action: '回调再买',
      buyPrice: 15.2,
      stopPrice: 14.6,
      targetPrice: 16.4,
      planQty: 2,
      actionPlan: '回踩15.20元买入2手',
    },
  })

  assert.equal(result.action, '观望')
  assert.equal(result.buyPrice, null)
  assert.equal(result.pullbackWatchPrice, 15.2)
  assert.equal(result.planQty, 0)
  assert.match(result.actionPlan, /下一交易日盘中小仓试仓预案/)
  assert.match(result.actionPlan, /盘中复核通过后人工确认/)
  assert.match(issues.join('；'), /当前已收盘/)
})

test('观望价必须有明确方向并贴近真实证据锚点', () => {
  const payload = {
    todayQuote: {
      price: 100,
      limitDownPrice: 90,
      limitUpPrice: 110,
    },
    tech: {
      atr: 2,
      resistance: 105,
    },
  }
  const anchored = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload,
    result: {
      action: '观望',
      timing: '放量站上105元后重新判断',
      watchPrice: 105,
    },
  })
  const unsupported = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload,
    result: {
      action: '观望',
      timing: '站上109.9元后重新判断',
      watchPrice: 109.9,
    },
  })

  assert.equal(anchored.result.watchPrice, null)
  assert.equal(anchored.result.breakoutWatchPrice, 105)
  assert.equal(
    anchored.result.priceContract.levels
      .find((level) => level.key === 'watch_breakout')?.strict,
    true,
  )
  assert.equal(unsupported.result.watchPrice, null)
  assert.equal(unsupported.result.breakoutWatchPrice, 105)
  assert.match(unsupported.issues.join('；'), /缺少邻近行情、技术或量化锚点/)
})

test('生成时已经满足的观望价不能继续伪装成未来条件', () => {
  const { result, valid, issues } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: {
      todayQuote: {
        price: 158.46,
        limitDownPrice: 142.61,
        limitUpPrice: 174.31,
      },
      tech: {
        atr: 3,
        resistance: 158.22,
      },
    },
    result: {
      action: '观望',
      actionPlan: '站上158.22元后重新判断',
      timing: '放量站上158.22元后重新判断',
      watchPrice: 158.22,
      planQty: 0,
    },
  })

  assert.equal(valid, false)
  assert.equal(result.watchPrice, null)
  assert.match(result.actionPlan, /暂无近期有效观察价/)
  assert.match(issues.join('；'), /方向已经满足/)
})

test('未持仓观望只保留观察价并移除无执行意义的止损目标', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: {
      todayQuote: {
        price: 16,
        limitDownPrice: 14.4,
        limitUpPrice: 17.6,
      },
      tech: {
        atr: 0.5,
        resistance: 17.12,
      },
    },
    result: {
      action: '观望',
      timing: '放量站上17.12元后重新判断',
      watchPrice: 17.12,
      stopPrice: 15.23,
      targetPrice: 18.6,
      planQty: 0,
    },
  })

  assert.equal(result.watchPrice, null)
  assert.equal(result.breakoutWatchPrice, 17.12)
  assert.equal(result.buyPrice, null)
  assert.equal(result.stopPrice, null)
  assert.equal(result.targetPrice, null)
})

test('远离现价的旧观察价替换为附近回踩与突破路径', () => {
  const { result } = reconcileAdviceNumbers({
    mode: 'buy_advice',
    payload: {
      todayQuote: {
        price: 128.61,
        low: 126.8,
        high: 130.2,
        limitDownPrice: 115.75,
        limitUpPrice: 141.47,
      },
      tech: {
        atr: 3,
        support: 89.09,
        resistance: 89.09,
      },
    },
    result: {
      action: '观望',
      timing: '站上89.09元后重新判断',
      watchPrice: 89.09,
      planQty: 0,
    },
  })

  assert.equal(result.watchPrice, null)
  assert.equal(result.pullbackWatchPrice, 126.8)
  assert.equal(result.breakoutWatchPrice, 130.2)
  assert.doesNotMatch(result.actionPlan, /89\.09/)
  assert.match(result.actionPlan, /回踩126\.8元企稳/)
  assert.match(result.actionPlan, /放量突破130\.2元/)
})
