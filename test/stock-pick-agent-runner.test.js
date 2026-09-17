import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockPickAgentInput,
  generateStockPickAgentSelection,
} from '../api/_stock_pick_agent.js'
import {
  handleNextDaySelection,
  handleNextDayRecalculation,
  handleStockPickAgent,
} from '../api/stock_pick.js'
import { createStockPickStore } from '../api/_stock_pick_store.js'
import { STOCK_PICK_MODE } from '../shared/stockPickModes.js'

const snapshot = {
  availability: 'READY',
  tradeDate: '2026-09-17',
  rankingSource: 'MODEL',
  modelVersion: 'ranking-v1',
  candidates: [
    {
      code: '600000',
      name: '浦发银行',
      industry: '银行',
      quote: {
        price: 10,
        pct: 4,
        low: 9.8,
        high: 10.3,
        turnover: 6,
        volumeRatio: 2,
        tradeDate: '2026-09-17',
      },
      ranking: { source: 'MODEL', score: 0.8 },
      recallReasons: ['当日涨幅 4%'],
    },
  ],
}

function response(message) {
  return {
    selectedModel: 'stock-pick-model',
    done: () => {},
    resp: {
      ok: true,
      json: async () => ({ choices: [{ message }] }),
    },
  }
}

function finalPayload(overrides = {}) {
  return {
    conclusion: 'SELECT',
    overallReason: '资金与量价共振',
    stageAssessment: '市场环境允许小仓试错',
    selections: [{
      code: '600000',
      decision: 'BUY_NOW',
      rationale: '主力净流入且站上均价线',
      buyStrategy: {
        entryPrice: 10.1,
        positionPctMax: 5,
        plan: '回踩分两批',
      },
      timing: {
        trigger: '回踩10元企稳',
        window: '今日有效',
        nextSession: '次日看量能',
      },
      t1Plan: {
        overnightRisk: '隔夜跳空风险',
        nextDayAction: '次日跌破9.8元退出',
      },
      evidence: [{
        tool: 'stock_fund_flow',
        summary: '主力净流入0.5亿',
      }],
      counterCase: '大盘跳水放弃',
      invalidation: '跌破9.8元',
    }],
    limitations: [],
    ...overrides,
  }
}

function memoryStore() {
  return createStockPickStore({
    hasStorage: () => false,
    put: async () => {},
    readJson: async () => null,
    del: async () => {},
  })
}

test('buildStockPickAgentInput 保留真实模型来源并按人工代码收窄', async () => {
  const input = await buildStockPickAgentInput({
    snapshot,
    mode: STOCK_PICK_MODE.NEXT_DAY,
    codes: ['600000', '999999'],
    trigger: 'MANUAL_RECHECK',
  })
  assert.equal(input.mode, STOCK_PICK_MODE.NEXT_DAY)
  assert.equal(input.model.source, 'MODEL')
  assert.equal(input.model.version, 'ranking-v1')
  assert.deepEqual(input.candidates.map((item) => item.code), ['600000'])
})

test('generate：使用选股端点执行工具闭环并逐项输出轨迹', async () => {
  const calls = []
  const traces = []
  let round = 0
  const selection = await generateStockPickAgentSelection({
    snapshot,
    mode: STOCK_PICK_MODE.INTRADAY,
    now: Date.parse('2026-09-17T02:00:00Z'),
    agentRunId: 'run-1',
    ensureLlmConfig: async () => {},
    isLlmReady: (role) => role === 'sector',
    resolveModel: (role) => {
      assert.equal(role, 'sector')
      return 'stock-pick-model'
    },
    executeTool: async (name, args) => {
      calls.push([name, args])
      if (name === 'market_snapshot') {
        return { breadth: { up: 3200, down: 1800 } }
      }
      if (name === 'stock_quote') {
        return { code: args.code, price: 10.1, pct: 4.2 }
      }
      if (name === 'stock_fund_flow') {
        return { code: args.code, mainNetYi: 0.5 }
      }
      return { code: args.code, items: [] }
    },
    onTrace: async (event) => traces.push(event),
    callLlm: async (options) => {
      assert.equal(options.role, 'sector')
      round += 1
      if (round === 1) {
        return response({
          content: '',
          tool_calls: [
            {
              id: 'tool-1',
              function: {
                name: 'market_snapshot',
                arguments: '{}',
              },
            },
            {
              id: 'tool-2',
              function: {
                name: 'stock_quote',
                arguments: '{"code":"600000"}',
              },
            },
            {
              id: 'tool-3',
              function: {
                name: 'stock_fund_flow',
                arguments: '{"code":"600000"}',
              },
            },
          ],
        })
      }
      return response({ content: JSON.stringify(finalPayload()) })
    },
  })
  assert.equal(selection.availability, 'READY')
  assert.equal(selection.mode, STOCK_PICK_MODE.INTRADAY)
  assert.equal(selection.selections[0].code, '600000')
  assert.equal(selection.selections[0].t1Plan.earliestSell, 'NEXT_TRADING_DAY')
  assert.deepEqual(calls.map(([name]) => name), [
    'market_snapshot',
    'stock_quote',
    'stock_fund_flow',
  ])
  assert.ok(traces.some((item) => item.type === 'tool'))
  assert.ok(traces.some((item) => item.stage === 'DONE'))
})

test('generate：模型漏调必需工具时由服务端补齐再形成结论', async () => {
  const calls = []
  let round = 0
  const selection = await generateStockPickAgentSelection({
    snapshot,
    mode: STOCK_PICK_MODE.NEXT_DAY,
    trigger: 'INITIAL',
    ensureLlmConfig: async () => {},
    isLlmReady: () => true,
    resolveModel: () => 'stock-pick-model',
    executeTool: async (name, args) => {
      calls.push([name, args])
      return name === 'stock_announcements'
        ? { code: args.code, items: [] }
        : { code: args.code, ok: true }
    },
    callLlm: async () => {
      round += 1
      return response({
        content: JSON.stringify(finalPayload()),
      })
    },
  })
  assert.equal(round, 2)
  assert.deepEqual(new Set(calls.map(([name]) => name)), new Set([
    'market_snapshot',
    'stock_quote',
    'stock_fund_flow',
    'stock_announcements',
  ]))
  assert.equal(
    selection.selections[0].decision,
    'WATCH_NEXT_DAY',
  )
})

test('generate：LLM 超时明确不可用，不伪造结果', async () => {
  const selection = await generateStockPickAgentSelection({
    snapshot,
    now: Date.now(),
    ensureLlmConfig: async () => {},
    isLlmReady: () => true,
    resolveModel: () => 'stock-pick-model',
    callLlm: async () => ({
      done: () => {},
      resp: { __err: { name: 'AbortError' } },
    }),
  })
  assert.equal(selection.availability, 'UNAVAILABLE')
  assert.equal(selection.reasonCode, 'AGENT_TIMEOUT')
})

test('handler agent：无召回快照时不可用并返回空参考', async () => {
  const store = memoryStore()
  const result = await handleStockPickAgent({
    store,
    generate: async () => { throw new Error('不该被调用') },
  })
  assert.equal(result.selection.availability, 'UNAVAILABLE')
  assert.equal(result.selection.reasonCode, 'NO_RECALL_SNAPSHOT')
})

test('handler agent：三模式结果与运行轨迹独立保存', async () => {
  const store = memoryStore()
  await store.saveLatest(snapshot)
  const result = await handleStockPickAgent({
    store,
    mode: STOCK_PICK_MODE.EARLY_LAYOUT,
    scope: 'alice',
    generate: async ({ mode, onTrace }) => {
      await onTrace({
        type: 'result',
        status: 'done',
        stage: 'DONE',
        percent: 100,
        runStatus: 'DONE',
        label: '完成',
      })
      return {
        ...finalPayload(),
        schemaVersion: 'stock-pick-agent.v2',
        availability: 'READY',
        mode,
      }
    },
  })
  assert.equal(result.selection.mode, STOCK_PICK_MODE.EARLY_LAYOUT)
  assert.equal(
    (await store.readAgent(
      STOCK_PICK_MODE.EARLY_LAYOUT,
      'alice',
    )).mode,
    STOCK_PICK_MODE.EARLY_LAYOUT,
  )
  assert.equal(
    (await store.readAgentProgress(
      STOCK_PICK_MODE.EARLY_LAYOUT,
      'alice',
    )).status,
    'DONE',
  )
})

test('次日关注名单只保存当前候选且与账号隔离', async () => {
  const store = memoryStore()
  await store.saveLatest(snapshot)
  const result = await handleNextDaySelection({
    store,
    scope: 'alice',
    codes: ['600000', '999999'],
    now: () => 123,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.nextDaySelection.items.map((item) => item.code),
    ['600000'],
  )
  assert.equal(await store.readNextDaySelection('bob'), null)
})

test('首报价自动复算只允许人工保存名单且对交易日幂等', async () => {
  const store = memoryStore()
  await store.saveLatest(snapshot)
  await store.saveNextDaySelection({
    sourceTradeDate: '2026-09-17',
    items: [{ code: '600000', name: '浦发银行' }],
    autoRecalculatedTradeDate: '',
  }, 'alice')
  const result = await handleNextDayRecalculation({
    store,
    scope: 'alice',
    trigger: 'FIRST_QUOTE',
    now: () => Date.parse('2026-09-18T01:31:00Z'),
    fetchQuoteList: async () => [{
      code: '600000',
      price: 10.2,
      tradeDate: '2026-09-18',
      isLivePrice: true,
    }],
    generate: async ({ codes, trigger }) => ({
      ...finalPayload(),
      schemaVersion: 'stock-pick-agent.v2',
      availability: 'READY',
      conclusion: 'SELECT',
      mode: STOCK_PICK_MODE.NEXT_DAY,
      trigger,
      selections: [{
        ...finalPayload().selections[0],
        code: codes[0],
      }],
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(
    result.nextDaySelection.autoRecalculatedTradeDate,
    '2026-09-18',
  )

  const replay = await handleNextDayRecalculation({
    store,
    scope: 'alice',
    trigger: 'FIRST_QUOTE',
    fetchQuoteList: async () => [{
      code: '600000',
      price: 10.2,
      tradeDate: '2026-09-18',
      isLivePrice: true,
    }],
  })
  assert.equal(replay.skipped, true)
  assert.equal(replay.reasonCode, 'FIRST_QUOTE_NOT_READY')
})
