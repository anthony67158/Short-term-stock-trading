import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STOCK_PICK_MODE,
  appendStockPickTrace,
  candidateSubset,
  createStockPickTrace,
  firstQuoteRecalculationCodes,
  normalizeNextDaySelection,
  normalizeStockPickMode,
} from '../shared/stockPickModes.js'
import { createStockPickStore } from '../api/_stock_pick_store.js'

const snapshot = {
  tradeDate: '2026-09-17',
  candidates: [
    {
      code: '600000',
      name: '浦发银行',
      ranking: { source: 'MODEL', score: 0.8 },
    },
    {
      code: '000001',
      name: '平安银行',
      ranking: { source: 'MODEL', score: 0.7 },
    },
  ],
}

function memoryStore() {
  return createStockPickStore({
    hasStorage: () => false,
    put: async () => {},
    readJson: async () => null,
    del: async () => {},
  })
}

test('三种选股模式使用固定枚举且未知值回落盘中机会', () => {
  assert.equal(normalizeStockPickMode('early_layout'), STOCK_PICK_MODE.EARLY_LAYOUT)
  assert.equal(normalizeStockPickMode('NEXT_DAY'), STOCK_PICK_MODE.NEXT_DAY)
  assert.equal(normalizeStockPickMode('unknown'), STOCK_PICK_MODE.INTRADAY)
})

test('候选子集与次日人工名单只能包含当前模型候选', () => {
  assert.deepEqual(
    candidateSubset(snapshot, ['000001', '999999']).map((item) => item.code),
    ['000001'],
  )
  const selection = normalizeNextDaySelection({
    snapshot,
    codes: ['000001', '999999', '000001'],
    now: 123,
  })
  assert.deepEqual(selection.items.map((item) => item.code), ['000001'])
  assert.equal(selection.sourceTradeDate, '2026-09-17')
  assert.equal(selection.savedAt, 123)
})

test('首报价自动复算只返回人工名单内且跨交易日的实时价', () => {
  const selection = normalizeNextDaySelection({
    snapshot,
    codes: ['600000'],
    now: 123,
  })
  const codes = firstQuoteRecalculationCodes(selection, [
    {
      code: '600000',
      price: 10.2,
      tradeDate: '2026-09-18',
      isLivePrice: true,
    },
    {
      code: '000001',
      price: 11,
      tradeDate: '2026-09-18',
      isLivePrice: true,
    },
    {
      code: '600000',
      price: 10,
      tradeDate: '2026-09-17',
      isLivePrice: true,
    },
  ])
  assert.deepEqual(codes, ['600000'])
  assert.deepEqual(
    firstQuoteRecalculationCodes({
      ...selection,
      autoRecalculatedTradeDate: '2026-09-18',
    }, [{
      code: '600000',
      price: 10.2,
      tradeDate: '2026-09-18',
      isLivePrice: true,
    }]),
    [],
  )
})

test('Agent 轨迹保留阶段、工具、异常与完成状态', () => {
  const started = createStockPickTrace({
    mode: STOCK_PICK_MODE.NEXT_DAY,
    runId: 'run-1',
    now: 100,
  })
  const calling = appendStockPickTrace(started, {
    type: 'tool',
    status: 'running',
    stage: 'TOOLS',
    percent: 45,
    label: '查询个股资金',
    tool: 'stock_fund_flow',
  }, 110)
  const done = appendStockPickTrace(calling, {
    type: 'result',
    status: 'done',
    stage: 'DONE',
    percent: 100,
    runStatus: 'DONE',
    label: '已形成次日关注结论',
  }, 120)
  assert.equal(done.mode, STOCK_PICK_MODE.NEXT_DAY)
  assert.equal(done.status, 'DONE')
  assert.equal(done.events.length, 2)
  assert.equal(done.events[0].tool, 'stock_fund_flow')
  assert.equal(done.finishedAt, 120)
})

test('选股存储按账户与模式隔离结果、轨迹和次日名单', async () => {
  const store = memoryStore()
  await store.saveAgent({ id: 'a' }, STOCK_PICK_MODE.INTRADAY, 'alice')
  await store.saveAgent({ id: 'b' }, STOCK_PICK_MODE.NEXT_DAY, 'alice')
  await store.saveAgent({ id: 'c' }, STOCK_PICK_MODE.INTRADAY, 'bob')
  await store.saveAgentProgress({ status: 'RUNNING' }, STOCK_PICK_MODE.NEXT_DAY, 'alice')
  await store.saveNextDaySelection({ items: [{ code: '600000' }] }, 'alice')

  assert.equal(
    (await store.readAgent(STOCK_PICK_MODE.INTRADAY, 'alice')).id,
    'a',
  )
  assert.equal(
    (await store.readAgent(STOCK_PICK_MODE.NEXT_DAY, 'alice')).id,
    'b',
  )
  assert.equal(
    (await store.readAgent(STOCK_PICK_MODE.INTRADAY, 'bob')).id,
    'c',
  )
  assert.equal(
    (await store.readAgentProgress(STOCK_PICK_MODE.NEXT_DAY, 'alice')).status,
    'RUNNING',
  )
  assert.equal(
    (await store.readNextDaySelection('alice')).items[0].code,
    '600000',
  )
})
