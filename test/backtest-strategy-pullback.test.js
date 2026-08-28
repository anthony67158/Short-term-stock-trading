import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generatePullbackDipSignals,
  latestBuyPlan,
  PULLBACK_DIP_DEFAULTS,
} from '../shared/backtest/strategies/pullbackDipBuy.js'

// 构造：先20+日强势上涨（满足动量与MA20之上），再缩量回踩到MA10企稳。
function strongThenPullback() {
  const rows = []
  let price = 10
  // 22 日稳步上涨（每日约 +1%）建立强势与均线多头
  for (let i = 0; i < 22; i += 1) {
    const open = price
    price = +(price * 1.01).toFixed(2)
    rows.push({
      date: `2026${String(6).padStart(2, '0')}${String(i + 1).padStart(2, '0')}`,
      open,
      high: +(price * 1.005).toFixed(2),
      low: +(open * 0.997).toFixed(2),
      close: price,
      volume: 1_000_000,
    })
  }
  // 回踩序列：连续两根缩量回落，把价格拉回到 MA10 附近（而不是悬在高位）
  const pushDip = (date, open, close, low, volume) => {
    rows.push({
      date,
      open,
      high: +(Math.max(open, close) * 1.004).toFixed(2),
      low,
      close,
      volume,
    })
  }
  let p = price
  // 回落第1根：中阴缩量
  pushDip('20260701', p, +(p * 0.97).toFixed(2), +(p * 0.965).toFixed(2), 700_000)
  p = rows[rows.length - 1].close
  // 回落第2根：继续小阴缩量，逼近 MA10
  pushDip('20260702', p, +(p * 0.985).toFixed(2), +(p * 0.98).toFixed(2), 620_000)
  // 企稳阳线：低点探至 MA10 下方后收回，缩量、收盘>开盘（承接确认）
  const dipOpen = rows[rows.length - 1].close
  rows.push({
    date: '20260703',
    open: dipOpen,
    high: +(dipOpen * 1.02).toFixed(2),
    low: +(dipOpen * 0.985).toFixed(2),
    close: +(dipOpen * 1.012).toFixed(2),
    volume: 640_000,
  })
  // 后续给足退出所需K线（继续上行以触发止盈）
  let q = rows[rows.length - 1].close
  for (let i = 4; i <= 14; i += 1) {
    const open = q
    q = +(q * 1.02).toFixed(2)
    rows.push({ date: `202607${String(i).padStart(2, '0')}`, open, high: +(q * 1.01).toFixed(2), low: +(open * 0.995).toFixed(2), close: q, volume: 900_000 })
  }
  return rows
}

test('强势回踩企稳形态产生买入信号', () => {
  const signals = generatePullbackDipSignals(strongThenPullback())
  const buys = signals.filter((s) => s.side === 'BUY')
  assert.ok(buys.length >= 1, '应至少产生一个回踩买入信号')
  assert.match(buys[0].reason, /强势回踩/)
})

test('买入后按止盈/止损/时间止损产生配对卖出', () => {
  const signals = generatePullbackDipSignals(strongThenPullback())
  const hasBuy = signals.some((s) => s.side === 'BUY')
  const hasSell = signals.some((s) => s.side === 'SELL')
  assert.ok(hasBuy && hasSell, '应形成买入+卖出的完整闭环')
})

test('单调下跌趋势中不产生买入信号', () => {
  const rows = []
  let price = 20
  for (let i = 0; i < 30; i += 1) {
    const open = price
    price = +(price * 0.98).toFixed(2)
    rows.push({
      date: `202606${String(i + 1).padStart(2, '0')}`.slice(0, 8),
      open,
      high: +(open * 1.002).toFixed(2),
      low: +(price * 0.995).toFixed(2),
      close: price,
      volume: 1_000_000,
    })
  }
  const signals = generatePullbackDipSignals(rows)
  assert.equal(signals.filter((s) => s.side === 'BUY').length, 0)
})

test('买入信号携带可执行计划：触发价/止损/止盈/盈亏比', () => {
  const signals = generatePullbackDipSignals(strongThenPullback())
  const buy = signals.find((s) => s.side === 'BUY')
  assert.ok(buy?.plan, '买入信号应带 plan')
  const p = buy.plan
  assert.ok(p.entryTriggerPrice > 0)
  assert.ok(p.stopPrice > 0 && p.stopPrice < p.entryTriggerPrice, '止损应低于触发价')
  assert.ok(p.targetPrice > p.entryTriggerPrice, '止盈应高于触发价')
  assert.ok(p.riskReward >= 1.9 && p.riskReward <= 2.1, '默认盈亏比约2:1')
  assert.equal(p.entryWindow, '下一交易日盘中')
})

test('latestBuyPlan 在最新形态触发时给出可执行买入计划', () => {
  // 用以企稳日结尾的序列（不含后续上涨尾巴），使买点恰好落在最新K线。
  const full = strongThenPullback()
  // strongThenPullback 的企稳阳线是第 25 根（索引 24）之后紧跟上涨尾巴；
  // 截断到企稳日为止，模拟"今天刚形成买点"。
  const stabilizeIdx = full.findIndex((bar) => bar.date === '20260703')
  const bars = full.slice(0, stabilizeIdx + 1)
  const result = latestBuyPlan(bars)
  assert.equal(result.actionable, true)
  assert.ok(result.plan.entryTriggerPrice > 0)
  assert.ok(result.plan.stopPrice < result.plan.entryTriggerPrice)
  assert.equal(result.signalDate, '20260703')
})

test('latestBuyPlan 对陈旧买点返回不可执行并说明原因', () => {
  const bars = strongThenPullback()
  // 在买点之后再接一长段与形态无关的横盘，使买点超出新鲜窗口
  let p = bars.at(-1).close
  let idx = 20
  for (let i = 0; i < 12; i += 1) {
    const open = p
    p = +(p * 1.0).toFixed(2)
    bars.push({ date: `202608${String(idx).padStart(2, '0')}`, open, high: +(p * 1.002).toFixed(2), low: +(p * 0.998).toFixed(2), close: p, volume: 1_000_000 })
    idx += 1
  }
  const result = latestBuyPlan(bars, {}, { lookbackBars: 2 })
  assert.equal(result.actionable, false)
  assert.match(result.reason, /新鲜|重新确认|无符合/)
})

test('无买点时 latestBuyPlan 返回不可执行', () => {
  const rows = []
  let price = 20
  for (let i = 0; i < 30; i += 1) {
    const open = price
    price = +(price * 0.98).toFixed(2)
    rows.push({ date: `202606${String(i + 1).padStart(2, '0')}`.slice(0, 8), open, high: +(open * 1.002).toFixed(2), low: +(price * 0.995).toFixed(2), close: price, volume: 1e6 })
  }
  const result = latestBuyPlan(rows)
  assert.equal(result.actionable, false)
})

test('资金承接确认：主力净流出时过滤掉买点', () => {
  const bars = strongThenPullback()
  // 找到会触发买点的企稳日
  const baseSignals = generatePullbackDipSignals(bars)
  const buy = baseSignals.find((s) => s.side === 'BUY')
  assert.ok(buy, '基线应有买点')

  // 构造该日主力净流出的资金流 → 开启承接确认后应被过滤
  const flowOut = {}
  for (const bar of bars) flowOut[bar.date] = { mainNetWan: -5000 }
  const filtered = generatePullbackDipSignals(bars, {
    requireFlowConfirm: true,
    flowConfirmWindow: 3,
    flowMinNetWan: 0,
  }, { moneyflowByDate: flowOut })
  assert.equal(filtered.filter((s) => s.side === 'BUY').length, 0, '主力净流出应过滤买点')

  // 主力净流入 → 买点保留
  const flowIn = {}
  for (const bar of bars) flowIn[bar.date] = { mainNetWan: 8000 }
  const confirmed = generatePullbackDipSignals(bars, {
    requireFlowConfirm: true,
    flowConfirmWindow: 3,
    flowMinNetWan: 0,
  }, { moneyflowByDate: flowIn })
  assert.ok(confirmed.some((s) => s.side === 'BUY'), '主力净流入应保留买点')
})

test('资金承接确认开启但缺资金数据时保守跳过', () => {
  const bars = strongThenPullback()
  const signals = generatePullbackDipSignals(bars, {
    requireFlowConfirm: true,
  }, { moneyflowByDate: null })
  assert.equal(signals.filter((s) => s.side === 'BUY').length, 0, '缺数据应不买')
})

test('默认参数暴露且可覆盖', () => {
  assert.equal(PULLBACK_DIP_DEFAULTS.anchor, 'ma10')
  const signals = generatePullbackDipSignals(strongThenPullback(), {
    momentumMinPct: 999, // 极高动量门槛→不可能触发
  })
  assert.equal(signals.filter((s) => s.side === 'BUY').length, 0)
})
