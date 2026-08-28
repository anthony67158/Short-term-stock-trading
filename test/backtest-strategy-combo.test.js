import test from 'node:test'
import assert from 'node:assert/strict'

import {
  passesComboGates,
  generateComboSignals,
  COMBO_DEFAULTS,
} from '../shared/backtest/strategies/comboMomentum.js'
import { runSingleAssetBacktest } from '../shared/backtest/engine.js'

function board(overrides = {}) {
  return {
    date: '20260110', code: '600000.SH', name: '测试', industry: '半导体',
    limitType: 'U', limitTimes: 1, openTimes: 0,
    fdAmount: 2e8, floatMv: 2e10, firstTime: '94500', close: 11,
    ...overrides,
  }
}

function fullCtx() {
  return {
    emotionByDate: { '20260110': { momentumAllowed: true } },
    hotSeatNetByCodeDate: { '600000.SH|20260110': 3000 },
    sectorLimitCountByDate: { '20260110': { 半导体: 5 } },
  }
}

test('全闸门通过：情绪+首板质量+席位+板块共振', () => {
  const gate = passesComboGates(board(), fullCtx())
  assert.equal(gate.pass, true)
  assert.ok(gate.reasons.length >= 4)
})

test('情绪冰点时一票否决', () => {
  const ctx = fullCtx()
  ctx.emotionByDate['20260110'].momentumAllowed = false
  assert.equal(passesComboGates(board(), ctx).pass, false)
})

test('无热钱席位背书时否决', () => {
  const ctx = fullCtx()
  ctx.hotSeatNetByCodeDate = {}
  assert.equal(passesComboGates(board(), ctx).pass, false)
})

test('板块无共振时否决', () => {
  const ctx = fullCtx()
  ctx.sectorLimitCountByDate['20260110']['半导体'] = 1
  assert.equal(passesComboGates(board(), ctx).pass, false)
})

test('消融：关闭席位闸门后不再要求热钱背书', () => {
  const ctx = fullCtx()
  ctx.hotSeatNetByCodeDate = {}
  const gate = passesComboGates(board(), ctx, {
    ...COMBO_DEFAULTS, useSeatQuality: false,
  })
  assert.equal(gate.pass, true)
})

test('组合信号可回测并在次日开盘进场', () => {
  const boards = [board()]
  const bars = [
    { date: '20260110', open: 10.5, high: 11, low: 10.4, close: 11, volume: 1e6 },
    { date: '20260111', open: 11.2, high: 12.3, low: 11.0, close: 12.1, volume: 1.5e6 },
    { date: '20260112', open: 12.1, high: 12.5, low: 11.8, close: 12.2, volume: 1e6 },
  ]
  const signals = generateComboSignals(boards, bars, fullCtx())
  const buy = signals.find((s) => s.side === 'BUY')
  assert.ok(buy)
  assert.equal(buy.date, '20260111')
  assert.match(buy.reason, /组合过滤/)
  const result = runSingleAssetBacktest({ security: { code: '600000.SH' }, bars, signals })
  assert.ok(typeof result.trades.length === 'number')
})

test('全闸门关闭时退化为纯首板次日进场', () => {
  const allOff = {
    useEmotionGate: false, useBoardQuality: false,
    useSeatQuality: false, useSectorResonance: false,
  }
  // 即便是低质量board(连板/尾盘)，闸门全关也应通过
  const gate = passesComboGates(board({ limitTimes: 5, firstTime: '145900' }), {}, allOff)
  assert.equal(gate.pass, true)
})
