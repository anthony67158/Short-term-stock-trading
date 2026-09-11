import test from 'node:test'
import assert from 'node:assert/strict'
import { runFormulaSelection } from '../api/formula_selection.js'

test('all deep candidates compete before display truncation and retain ledger results', async () => {
  const deep = Array.from({ length: 15 }, (_, i) => ({
    code: String(600001 + i), name: '测试股票',
    score: 100 - i, formulaId: 'UNKNOWN',
    route: 'IMMEDIATE', primaryPrice: 10, stopPrice: 9, targetPrice: 12,
    priceType: 'IMMEDIATE', priceContractValid: true,
    quote: { price: 10, amount: 1e9, pct: 1 },
    actionAlternatives: [{
      route: 'PULLBACK', primaryPrice: 9.8, stopPrice: 9, targetPrice: 12,
    }, {
      route: 'BREAKOUT', primaryPrice: 10.2, stopPrice: 9, targetPrice: 12,
    }],
  }))
  const inputs = []
  let ledger
  const result = await runFormulaSelection({
    mode: 'close', now: () => Date.UTC(2026, 8, 11, 8),
    store: {
      readLatest: async () => null, saveRun: async () => {},
      saveProgress: async () => {}, claimRun: async () => ({ acquired: true }),
      releaseRun: async () => true,
    },
    ledgerStore: { saveBatch: async (batch) => { ledger = batch } },
    readTrainingStatus: async () => null,
    collectMarketContext: async () => ({ marketGate: { allowed: true } }),
    scan: async () => ({
      universe: { total: 15, inspectedCount: 15 }, formulas: [],
      candidates: deep.slice(0, 12), deepCandidates: deep,
      candidateEvents: deep.map((c) => ({
        code: c.code, name: c.name, quote: c.quote, decision: c,
        stageReached: 'EVIDENCE', counterfactualPlans: [],
      })),
    }),
    scoreOpportunities: async (items) => {
      inputs.push(...items)
      return new Map(items.map((input) => [input.code, {
        state: 'READY', usagePolicy: 'DIRECT', modelVersion: 'test',
        pFill: 0.8, pWinGivenFill: 0.7, expectedNetR: 0.5,
        netRLowerBound: -0.1, expectedShortfall10: -1,
        rankingScore: input.code === '600015' ? 1 : 0.1,
      }]))
    },
  })
  assert.equal(result.candidates.length, 12)
  assert.equal(result.decisionScoring.requested, 15)
  assert.equal(result.decisionScoring.direct, 15)
  assert.equal(result.candidates[0].code, '600015')
  assert.deepEqual(new Set(inputs.filter((i) => i.code === '600015').map((i) => i.dimensions.route)),
    new Set(['IMMEDIATE', 'PULLBACK', 'BREAKOUT']))
  assert.equal(ledger.events.length, 15)
  assert.equal(ledger.events.filter((e) => e.stageReached === 'DISPLAYED').length, 12)
  assert.equal(ledger.events.find((e) => e.code === '600015').displayedRank, 1)
})
