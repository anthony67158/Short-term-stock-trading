import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  OPPORTUNITY_SCORE_FEATURE_NAMES,
} from '../shared/opportunityScoreContract.js'
import {
  migrateOpportunityHistoryV5,
} from '../scripts/migrate-opportunity-history-v5.mjs'

const contract = JSON.parse(readFileSync(
  new URL(
    '../qlib-service/contracts/opportunity-score-features.json',
    import.meta.url,
  ),
  'utf8',
))

function legacyOutcome(mode = 'CLOSE') {
  const defaults = new Set(
    contract.legacyDefaultsByVersion['opportunity-score-feature.v4'],
  )
  const factors = Object.fromEntries(
    OPPORTUNITY_SCORE_FEATURE_NAMES
      .filter((name) => !defaults.has(name))
      .map((name) => [name, 0]),
  )
  factors.atrPct = 1.2
  factors.vwapDistancePct = 0.3
  return {
    decisionId: `formula:2026-09-08:${mode.toLowerCase()}:1510:600001`,
    tradeDate: '2026-09-08',
    mode,
    code: '600001',
    context: { historicalBackfill: true },
    scoreInput: {
      schemaVersion: 'opportunity-score-feature.v4',
      code: '600001',
      formulaId: 'UNKNOWN',
      factors,
      dimensions: {
        mode,
        sectorPhase: 'ACCUMULATION',
        sectorActionability: 'LAYOUT',
      },
    },
  }
}

const fundRows = [
  ['20260903', 1, -1],
  ['20260904', -2, 2],
  ['20260905', 3, -3],
  ['20260906', 4, -4],
  ['20260907', 5, -5],
  ['20260908', 9, -4],
].map(([date, mainNetYi, retailNetYi]) => ({
  date,
  code: '600001',
  mainNetYi,
  retailNetYi,
}))

test('V4资金迁移只升级到V5，不把缺失形态补零冒充V6', () => {
  const result = migrateOpportunityHistoryV5(
    { outcomes: [legacyOutcome()] },
    fundRows,
    contract,
  )
  const factors = result.outcomes[0].scoreInput.factors

  assert.equal(
    result.outcomes[0].scoreInput.schemaVersion,
    'opportunity-score-feature.v5',
  )
  const patterns = new Set(contract.legacyDefaultsByVersion['opportunity-score-feature.v5'])
  assert.deepEqual(Object.keys(factors), OPPORTUNITY_SCORE_FEATURE_NAMES.filter((n) => !patterns.has(n)))
  assert.equal('patternHistoryCoverage' in factors, false)
  assert.equal(factors.fundCurrentAvailable, 1)
  assert.equal(factors.fundHistoryComplete, 1)
  assert.equal(factors.main5dYi, 19)
  assert.equal(factors.retail5dYi, -14)
  assert.equal(factors.mainStreak5, 4)
  assert.equal(factors.retailStreak5, -4)
  assert.equal(factors.dailyTechnicalAvailable, 1)
  assert.equal(factors.intradayTechnicalAvailable, 1)
  assert.equal(factors.sectorContextAvailable, 1)
})

test('V4盘中样本不读取当日盘后资金', () => {
  const result = migrateOpportunityHistoryV5(
    { outcomes: [legacyOutcome('INTRADAY')] },
    fundRows,
    contract,
  )
  const factors = result.outcomes[0].scoreInput.factors

  assert.equal(factors.fundCurrentAvailable, 0)
  assert.equal(factors.mainNetYi, 0)
  assert.equal(factors.retailNetYi, 0)
  assert.equal(factors.main5dYi, 11)
  assert.equal(factors.retail5dYi, -11)
  assert.equal(factors.fundHistoryComplete, 1)
})
