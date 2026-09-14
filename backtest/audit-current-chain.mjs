import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { buildDecisionState } from '../shared/decisionStateContract.js'
import { arbitrateActionValues } from '../shared/actionValueArbiter.js'
import { validateStockOrder } from './etf/execution.mjs'

// An envelope must retain the original state and scores, not fabricate DIRECT scores.
export function replayArbitration(envelope) {
  if (!envelope?.stateInput || !Array.isArray(envelope.plans)) {
    throw new Error('DECISION_ENVELOPE_REQUIRED')
  }
  const { stateInput, plans } = envelope
  if (!stateInput.account || !stateInput.evidence || !stateInput.model
      || !Number.isFinite(stateInput.asOf)) throw new Error('INCOMPLETE_STATE')
  const state = buildDecisionState(stateInput)
  const result = arbitrateActionValues({ state, plans })
  return { stateFingerprint: state.stateFingerprint, action: result.action,
    reason: result.reason, vector: result.vector }
}

export function auditLegacyResult(result, permissions = {}) {
  const firstValidation = result.directFolds?.[0]?.validationStartDate?.replaceAll('-', '')
  if (!firstValidation) throw new Error('FOLD_DATES_REQUIRED')
  const variants = Object.entries(result.variants).map(([name, item]) => {
    const portfolio = item.portfolio
    const dates = portfolio.equityCurve.map(row => row.date)
    const trades = portfolio.tradeSample || []
    return {
      name, reportedFinalEquity: portfolio.finalEquity,
      warmupDays: dates.filter(date => date < firstValidation).length,
      availableOosDays: dates.filter(date => date >= firstValidation).length,
      tradeRows: trades.length,
      illegalLotsEvenWithAllPermissions: trades.filter(trade => validateStockOrder({
        code: trade.code, quantity: trade.lots * 100,
        permissions: { star: true, chinext: true, bse: true },
      })).map(trade => ({ code: trade.code, quantity: trade.lots * 100 })),
      rejectedWithProvidedPermissions: trades.filter(trade => validateStockOrder({
        code: trade.code, quantity: trade.lots * 100, permissions,
      })).map(trade => ({ code: trade.code, quantity: trade.lots * 100,
        reason: validateStockOrder({ code: trade.code, quantity: trade.lots * 100, permissions }) })),
      completeTradeLedger: trades.length === portfolio.trades,
    }
  })
  return {
    schemaVersion: 'legacy-chain-audit.v1', productionEquivalent: false,
    correctedReturn: null,
    blockers: [
      'ORIGINAL_DECISION_STATE_AND_SCORE_ENVELOPES_MISSING',
      'ACTUAL_ACCOUNT_PERMISSIONS_NOT_PROVIDED',
      'PRODUCTION_SIZING_AND_LIFECYCLE_NOT_REPLAYED',
      'RESEARCH_MODELS_NOT_PRODUCTION_ELIGIBLE',
    ],
    variants,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2]
  if (!input) throw new Error('Usage: node backtest/audit-current-chain.mjs result.json')
  const raw = fs.readFileSync(input)
  console.log(JSON.stringify({
    ...auditLegacyResult(JSON.parse(raw)),
    inputSha256: createHash('sha256').update(raw).digest('hex'),
  }, null, 2))
  process.exitCode = 2
}
