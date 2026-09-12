import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { evaluateDecision } from '../api/_decision_orchestrator.js'

const now = Date.parse('2026-09-10T02:10:00Z')
const baseScore = {
  state: 'READY', usagePolicy: 'DIRECT', serverVerified: true,
  pFill: 0.8, pWinGivenFill: 0.6, expectedNetR: 0.8,
  netRLowerBound: -0.8, expectedShortfall10: -1.2,
  modelVersion: 'SYNTHETIC_ACCEPTANCE_ONLY',
}
const cases = [
  { id: 'build', held: false, expected: 'READY' },
  { id: 'watch', held: false, pullback: true, expected: 'WAIT_TRIGGER' },
  { id: 'add', held: true, pullback: true, expected: 'WAIT_TRIGGER' },
  { id: 'negative', held: false, negative: true, expected: 'NO_TRADE' },
  { id: 'missing', held: false, missing: true, expected: 'NO_TRADE' },
]
const results = []
for (const item of cases) {
  const book = {
    account: { cash: 100000 }, closed: [], executionPlans: [],
    holding: item.held ? [{ code: '600001', qty: 2, buyPrice: 9.5, sl: 9, buyAt: now - 86400000 }] : [],
  }
  const before = JSON.stringify(book)
  const result = await evaluateDecision({
    code: '600001', now, book,
    quotes: [{ code: '600001', price: 10, isLivePrice: true, tradeDate: '2026-09-10' }],
    detail: { candles: Array.from({ length: 30 }, () => ({
      close: 10, high: 10.2, low: 9.8, amount: item.missing ? null : 100000000,
    })) },
    trends: [], fund: { mainNetYi: 1, retailNetYi: -1 },
    market: { breadth: { up: 3000, down: 1000, flat: 100 } },
    score: async ([input]) => new Map([[input.code, {
      ...baseScore,
      expectedNetR: item.negative ? -0.2
        : item.pullback ? input.dimensions.route === 'PULLBACK' ? 0.8 : 0.02
          : input.dimensions.route === 'IMMEDIATE' ? 0.8 : 0.02,
    }]]),
  })
  assert.equal(JSON.stringify(book), before)
  const instruction = result.result.decisionRationale.entryInstruction
  assert.equal(instruction.state, item.expected, item.id)
  if (instruction.state === 'READY') {
    assert.equal(instruction.quantity.executableLots, result.result.executionPlan.targetLots)
    assert.equal(instruction.price.maxBuyPrice, result.result.executionPlan.maxBuyPrice)
  }
  results.push({ id: item.id, held: item.held, advice: result.result })
}
await mkdir('harness-artifacts/entry-instructions', { recursive: true })
await writeFile('harness-artifacts/entry-instructions/synthetic.json', JSON.stringify(results))
console.log(JSON.stringify({ passed: results.length, cloudWrites: 0, llmCalls: 0, scope: 'synthetic integration acceptance' }))
