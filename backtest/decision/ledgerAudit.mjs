import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

import {
  DECISION_ACCOUNT_SCHEMA_VERSION,
} from './accountEngine.mjs'

const OPEN_ORDER_STATES = new Set(['OPEN', 'PARTIALLY_FILLED'])

function integer(value) {
  return Number.isInteger(value) ? value : null
}

function issue(errors, code, expected, actual, context = {}) {
  if (expected === actual) return
  errors.push({ code, expected, actual, ...context })
}

function consumeFifo(layers, quantityShares) {
  let remaining = quantityShares
  let costBasisCents = 0
  while (remaining > 0 && layers.length) {
    const layer = layers[0]
    const matched = Math.min(remaining, layer.quantityShares)
    const allocated = Math.round(
      layer.costCents * matched / layer.quantityShares,
    )
    layer.quantityShares -= matched
    layer.costCents -= allocated
    remaining -= matched
    costBasisCents += allocated
    if (layer.quantityShares === 0) layers.shift()
  }
  return { remaining, costBasisCents }
}

function replayFills(fills, errors, throughDate = null) {
  const positions = {}
  let cashFlowCents = 0
  let feesCents = 0
  let realizedPnlCents = 0
  for (const fill of fills) {
    if (throughDate && fill.date > throughDate) continue
    const quantityShares = integer(fill.quantityShares)
    const cashFlow = integer(fill.cashFlowCents)
    const fee = integer(fill.feeCents)
    if (!(quantityShares > 0) || cashFlow == null || !(fee >= 0)) {
      errors.push({
        code: 'INVALID_FILL',
        sequence: fill.sequence,
      })
      continue
    }
    cashFlowCents += cashFlow
    feesCents += fee
    const code = String(fill.code || '')
    positions[code] ||= []
    if (fill.side === 'BUY') {
      if (cashFlow >= 0) {
        errors.push({
          code: 'INVALID_BUY_CASH_FLOW',
          sequence: fill.sequence,
        })
        continue
      }
      positions[code].push({
        acquiredDate: fill.date,
        quantityShares,
        costCents: -cashFlow,
      })
      continue
    }
    if (fill.side !== 'SELL' || cashFlow <= 0) {
      errors.push({
        code: 'INVALID_SELL_CASH_FLOW',
        sequence: fill.sequence,
      })
      continue
    }
    const consumed = consumeFifo(
      positions[code],
      quantityShares,
    )
    if (consumed.remaining > 0) {
      errors.push({
        code: 'SELL_EXCEEDS_POSITION',
        sequence: fill.sequence,
        actual: quantityShares,
        expected: quantityShares - consumed.remaining,
      })
    }
    issue(
      errors,
      'FILL_COST_BASIS_MISMATCH',
      consumed.costBasisCents,
      fill.costBasisCents,
      { sequence: fill.sequence },
    )
    const realized = cashFlow - consumed.costBasisCents
    issue(
      errors,
      'FILL_REALIZED_PNL_MISMATCH',
      realized,
      fill.realizedPnlCents,
      { sequence: fill.sequence },
    )
    realizedPnlCents += realized
    if (positions[code].length === 0) delete positions[code]
  }
  return {
    positions,
    cashFlowCents,
    feesCents,
    realizedPnlCents,
  }
}

function positionTotals(positions = {}) {
  return Object.fromEntries(
    Object.entries(positions).map(([code, value]) => {
      const layers = Array.isArray(value) ? value : value.layers || []
      return [code, {
        quantityShares: layers.reduce(
          (sum, layer) => sum + layer.quantityShares,
          0,
        ),
        costCents: layers.reduce(
          (sum, layer) => sum + layer.costCents,
          0,
        ),
      }]
    }),
  )
}

function auditPositions(errors, expected, actual, context = {}) {
  const expectedTotals = positionTotals(expected)
  const actualTotals = positionTotals(actual)
  const codes = new Set([
    ...Object.keys(expectedTotals),
    ...Object.keys(actualTotals),
  ])
  for (const code of codes) {
    issue(
      errors,
      'POSITION_QUANTITY_MISMATCH',
      expectedTotals[code]?.quantityShares || 0,
      actualTotals[code]?.quantityShares || 0,
      { ...context, securityCode: code },
    )
    issue(
      errors,
      'POSITION_COST_MISMATCH',
      expectedTotals[code]?.costCents || 0,
      actualTotals[code]?.costCents || 0,
      { ...context, securityCode: code },
    )
  }
}

function auditCurve(state, fills, errors) {
  for (const row of state.curve || []) {
    const replay = replayFills(fills, errors, row.date)
    const expectedCash = state.initialCashCents
      + replay.cashFlowCents
    issue(
      errors,
      'CURVE_CASH_MISMATCH',
      expectedCash,
      row.cashCents,
      { date: row.date },
    )
    issue(
      errors,
      'CURVE_FEE_MISMATCH',
      replay.feesCents,
      row.feesCents,
      { date: row.date },
    )
    let holdingsCents = 0
    const rowPositions = {}
    for (const [code, position] of Object.entries(
      row.positions || {},
    )) {
      const expectedMarketValue = Math.round(
        Number(position.price) * position.quantityShares * 100,
      )
      issue(
        errors,
        'CURVE_MARKET_VALUE_MISMATCH',
        expectedMarketValue,
        position.marketValueCents,
        { date: row.date, securityCode: code },
      )
      holdingsCents += position.marketValueCents
      rowPositions[code] = [{
        quantityShares: position.quantityShares,
        costCents: replay.positions[code]?.reduce(
          (sum, layer) => sum + layer.costCents,
          0,
        ) || 0,
      }]
    }
    auditPositions(
      errors,
      replay.positions,
      rowPositions,
      { date: row.date },
    )
    issue(
      errors,
      'CURVE_HOLDINGS_MISMATCH',
      holdingsCents,
      row.holdingsCents,
      { date: row.date },
    )
    issue(
      errors,
      'CURVE_EQUITY_MISMATCH',
      expectedCash + holdingsCents,
      row.equityCents,
      { date: row.date },
    )
    issue(
      errors,
      'CURVE_AVAILABLE_CASH_MISMATCH',
      row.cashCents - row.reservedCashCents,
      row.availableCashCents,
      { date: row.date },
    )
  }
}

export function auditDecisionAccount(state = {}) {
  const errors = []
  if (state.schemaVersion !== DECISION_ACCOUNT_SCHEMA_VERSION) {
    errors.push({
      code: 'ACCOUNT_VERSION_MISMATCH',
      expected: DECISION_ACCOUNT_SCHEMA_VERSION,
      actual: state.schemaVersion,
    })
  }
  const fills = [...(state.fills || [])].sort(
    (left, right) => left.sequence - right.sequence,
  )
  const replay = replayFills(fills, errors)
  const expectedCash = state.initialCashCents
    + replay.cashFlowCents
  const expectedReservedCash = (state.orders || [])
    .filter((order) => (
      order.side === 'BUY'
      && OPEN_ORDER_STATES.has(order.status)
    ))
    .reduce(
      (sum, order) => sum + order.reservedCashCents,
      0,
    )
  issue(
    errors,
    'CASH_MISMATCH',
    expectedCash,
    state.cashCents,
  )
  issue(
    errors,
    'RESERVED_CASH_MISMATCH',
    expectedReservedCash,
    state.reservedCashCents,
  )
  issue(
    errors,
    'AVAILABLE_CASH_MISMATCH',
    expectedCash - expectedReservedCash,
    state.availableCashCents,
  )
  issue(
    errors,
    'FEE_MISMATCH',
    replay.feesCents,
    state.feesCents,
  )
  issue(
    errors,
    'REALIZED_PNL_MISMATCH',
    replay.realizedPnlCents,
    state.realizedPnlCents,
  )
  auditPositions(errors, replay.positions, state.positions)
  auditCurve(state, fills, errors)
  return {
    ok: errors.length === 0,
    errors,
    summary: {
      cashCents: expectedCash,
      reservedCashCents: expectedReservedCash,
      feesCents: replay.feesCents,
      realizedPnlCents: replay.realizedPnlCents,
      positionCount: Object.keys(replay.positions).length,
      fillCount: fills.length,
      curveRows: (state.curve || []).length,
    },
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const inputPath = process.argv[2]
  if (!inputPath) {
    process.stderr.write(
      'Usage: node backtest/decision/ledgerAudit.mjs account.json\n',
    )
    process.exitCode = 2
  } else {
    const state = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
    const result = auditDecisionAccount(state)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  }
}
