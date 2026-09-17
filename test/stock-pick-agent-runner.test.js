import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStockPickAgentInput,
  generateStockPickAgentSelection,
} from '../api/_stock_pick_agent.js'
import { handleStockPickAgent } from '../api/stock_pick.js'
import { createStockPickStore } from '../api/_stock_pick_store.js'

const snapshot = {
  availability: 'READY',
  tradeDate: '2026-09-17',
  candidates: [
    {
      code: '600000', name: '浦发银行', industry: '银行',
      quote: { price: 10, pct: 4, low: 9.8, high: 10.3, turnover: 6, volumeRatio: 2 },
      ranking: { source: 'MODEL', score: 0.8 },
      recallReasons: ['当日涨幅 4%'],
    },
  ],
}

const deps = {
  fetchMarket: async () => ({
    indices: [{ code: '000001', name: '上证', pct: 0.6, mainInflow: 3e9 }],
    breadth: { up: 3200, down: 1800, limitUp: 40, amountYi: 9000 },
  }),
  fetchFund: async () => ({ mainNetYi: 0.5, mainNetPct: 6, main5dYi: 1.2, retailNetYi: -0.3 }),
  fetchSearch: async () => ({ enabled: true, items: [{ title: '中标公告', src: '巨潮', publishedAt: '2026-09-16' }] }),
}

test('buildStockPickAgentInput 组装盘面/资金/新闻且过滤未来新闻', async () => {
  const input = await buildStockPickAgentInput({
    snapshot, now: Date.parse('2026-09-17T02:00:00Z'), ...deps,
    fetchSearch: async () => ({
      enabled: true,
      items: [
        { title: '历史公告', publishedAt: '2026-09-16' },
        { title: '未来新闻', publishedAt: '2027-01-01' },
      ],
    }),
  })
  assert.equal(input.candidates.length, 1)
  assert.equal(input.candidates[0].fund.mainNetYi, 0.5)
  assert.equal(input.candidates[0].news.items.length, 1)
  assert.equal(input.candidates[0].news.items[0].title, '历史公告')
})

test('generate：LLM 精选结果经合同复校，越界价回落现价', async () => {
  const selection = await generateStockPickAgentSelection({
    snapshot,
    now: Date.parse('2026-09-17T02:00:00Z'),
    agentRunId: 'run-1',
    ...deps,
    ensureLlmConfig: async () => {},
    isLlmReady: () => true,
    resolveModel: () => 'claude-sonnet',
    callLlm: async () => ({
      selectedModel: 'claude-sonnet',
      done: () => {},
      resp: {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                conclusion: 'SELECT',
                overallReason: '资金与量价共振',
                selections: [{
                  code: '600000',
                  rationale: '主力净流入且站上均价线',
                  buyStrategy: { entryPrice: 10.1, positionPctMax: 5, plan: '回踩分两批' },
                  timing: { trigger: '回踩10元企稳', window: '今日有效', nextSession: '次日看量能' },
                  counterCase: '大盘跳水放弃',
                  invalidation: '跌破9.8元',
                }],
                limitations: [],
              }),
            },
          }],
        }),
      },
    }),
  })
  assert.equal(selection.availability, 'READY')
  assert.equal(selection.conclusion, 'SELECT')
  assert.equal(selection.selections[0].code, '600000')
  assert.equal(selection.selections[0].buyStrategy.entryPrice, 10.1)
  assert.ok(selection.selections[0].timing.trigger.includes('回踩'))
})

test('generate：LLM 超时明确不可用，不伪造结果', async () => {
  const selection = await generateStockPickAgentSelection({
    snapshot, now: Date.now(), ...deps,
    ensureLlmConfig: async () => {},
    isLlmReady: () => true,
    resolveModel: () => 'claude',
    callLlm: async () => ({ done: () => {}, resp: { __err: { name: 'AbortError' } } }),
  })
  assert.equal(selection.availability, 'UNAVAILABLE')
  assert.equal(selection.reasonCode, 'AGENT_TIMEOUT')
})

test('handler agent：无召回快照时不可用并返回空参考', async () => {
  const store = createStockPickStore({
    hasStorage: () => false, put: async () => {}, readJson: async () => null, del: async () => {},
  })
  const result = await handleStockPickAgent({
    store,
    generate: async () => { throw new Error('不该被调用') },
  })
  assert.equal(result.selection.availability, 'UNAVAILABLE')
  assert.equal(result.selection.reasonCode, 'NO_RECALL_SNAPSHOT')
})

test('handler agent：Agent 不选时返回 Top 候选参考', async () => {
  const store = createStockPickStore({
    hasStorage: () => false, put: async () => {}, readJson: async () => null, del: async () => {},
  })
  await store.saveLatest(snapshot)
  const result = await handleStockPickAgent({
    store,
    generate: async () => ({
      schemaVersion: 'stock-pick-agent.v1',
      availability: 'READY',
      conclusion: 'NO_SELECTION',
      selections: [],
    }),
  })
  assert.equal(result.references.length, 1)
  assert.equal(result.references[0].code, '600000')
})
