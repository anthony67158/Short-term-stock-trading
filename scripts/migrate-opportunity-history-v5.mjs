#!/usr/bin/env node

import { gunzipSync } from 'node:zlib'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildOpportunityFundFeatures,
} from '../shared/opportunityShadowFeatures.js'
import {
  buildHistoricalFund,
} from './lib/stockdb-backfill-runtime.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const TARGET_SCHEMA = 'opportunity-score-feature.v5'
const CONTRACT_PATH = new URL(
  '../qlib-service/contracts/opportunity-score-features.json',
  import.meta.url,
)

function compactDate(value) {
  const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/)
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function args(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!['--input', '--funds', '--output'].includes(name)) {
      throw new Error(`未知V5迁移参数: ${name}`)
    }
    values[name.slice(2)] = argv[index + 1]
    index += 1
  }
  if (!values.input || !values.funds || !values.output) {
    throw new Error('V5迁移需要--input、--funds和--output')
  }
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      path.resolve(value),
    ]),
  )
}

function expectedNames(contract, schemaVersion) {
  if (schemaVersion === contract.featureSchemaVersion) {
    return contract.featureNames
  }
  if (!contract.legacyFeatureSchemaVersions.includes(schemaVersion)) {
    throw new Error(`不支持的机会特征版本: ${schemaVersion}`)
  }
  const defaults = new Set(
    contract.legacyDefaultsByVersion?.[schemaVersion]
    || contract.legacyDefaultZeroFeatures,
  )
  return contract.featureNames.filter((name) => !defaults.has(name))
}

function assertFactors(factors, names) {
  if (!factors || typeof factors !== 'object' || Array.isArray(factors)) {
    throw new Error('历史机会特征必须是对象')
  }
  const actual = Object.keys(factors)
  const expected = new Set(names)
  if (
    actual.length !== names.length
    || actual.some((name) => !expected.has(name))
    || actual.some((name) => finite(factors[name]) == null)
  ) {
    throw new Error('历史机会特征字段不匹配')
  }
}

function groupedFunds(rows) {
  const result = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.code || '')
    const date = compactDate(row?.date)
    if (!/^\d{6}$/.test(code) || !date) continue
    if (!result.has(code)) result.set(code, [])
    result.get(code).push({ ...row, date })
  }
  for (const values of result.values()) {
    values.sort((left, right) => left.date.localeCompare(right.date))
  }
  return result
}

function inferredAvailability(value, factors) {
  const historical = value?.context?.historicalBackfill === true
  const dimensions = value?.scoreInput?.dimensions || {}
  const hasSignal = (names) => names.some(
    (name) => Math.abs(finite(factors[name]) || 0) > 1e-9,
  )
  return {
    dailyTechnicalAvailable: historical || hasSignal([
      'ret2dPct',
      'ret5dPct',
      'atrPct',
      'limitHitCount5d',
      'failedLimitCount5d',
    ]) ? 1 : 0,
    intradayTechnicalAvailable: historical || hasSignal([
      'vwapDistancePct',
      'orderImbalanceShort',
      'signalOrderFlowContinuation',
    ]) ? 1 : 0,
    sectorContextAvailable: (
      String(dimensions.sectorPhase || 'UNKNOWN') !== 'UNKNOWN'
      || String(dimensions.sectorActionability || 'UNKNOWN') !== 'UNKNOWN'
    ) ? 1 : 0,
  }
}

export function migrateOpportunityOutcomeV5(
  value,
  {
    fundsByCode,
    contract,
  },
) {
  const scoreInput = value?.scoreInput
  const schemaVersion = String(scoreInput?.schemaVersion || '')
  const sourceNames = expectedNames(contract, schemaVersion)
  assertFactors(scoreInput?.factors, sourceNames)
  if (schemaVersion === TARGET_SCHEMA || schemaVersion === contract.featureSchemaVersion) {
    return structuredClone(value)
  }
  const tradeDate = compactDate(value.tradeDate)
  const code = String(value.code || scoreInput.code || '')
  if (!tradeDate || !/^\d{6}$/.test(code)) {
    throw new Error('历史机会样本身份无效')
  }
  const mode = String(
    value.mode || scoreInput.dimensions?.mode || '',
  ).toLowerCase() === 'close' ? 'close' : 'intraday'
  const historicalFund = buildHistoricalFund(
    fundsByCode.get(code) || [],
    tradeDate,
    mode,
  )
  const historicalBackfill = value?.context?.historicalBackfill === true
  if (mode === 'close' || !historicalBackfill) {
    const main = finite(scoreInput.factors.mainNetYi)
    const retail = finite(scoreInput.factors.retailNetYi)
    const currentWasObserved = (
      main !== 0
      || retail !== 0
    )
    historicalFund.mainNetYi = finite(historicalFund.mainNetYi)
      ?? (currentWasObserved ? main : null)
    historicalFund.retailNetYi = finite(historicalFund.retailNetYi)
      ?? (currentWasObserved ? retail : null)
  }
  const additions = {
    ...buildOpportunityFundFeatures(historicalFund),
    ...inferredAvailability(value, scoreInput.factors),
  }
  const factors = Object.fromEntries(
    expectedNames(contract, TARGET_SCHEMA).map((name) => [
      name,
      finite(additions[name])
        ?? finite(scoreInput.factors[name])
        ?? 0,
    ]),
  )
  return {
    ...value,
    scoreInput: {
      ...scoreInput,
      schemaVersion: TARGET_SCHEMA,
      factors,
    },
  }
}

export function migrateOpportunityHistoryV5(
  payload,
  fundRows,
  contract,
) {
  const outcomes = Array.isArray(payload)
    ? payload
    : payload?.outcomes
  if (!Array.isArray(outcomes) || !outcomes.length) {
    throw new Error('V5迁移输入不含历史机会样本')
  }
  if (!Array.isArray(fundRows) || !fundRows.length) {
    throw new Error('V5迁移输入不含历史资金')
  }
  const fundsByCode = groupedFunds(fundRows)
  const before = {}
  const migrated = outcomes.map((value) => {
    const schema = String(value?.scoreInput?.schemaVersion || '')
    before[schema] = (before[schema] || 0) + 1
    return migrateOpportunityOutcomeV5(value, {
      fundsByCode,
      contract,
    })
  })
  const coverage = migrated.reduce((summary, value) => {
    const factors = value.scoreInput.factors
    summary.currentFund += factors.fundCurrentAvailable === 1 ? 1 : 0
    summary.fundHistory += factors.fundHistoryAvailable === 1 ? 1 : 0
    summary.completeFundHistory +=
      factors.fundHistoryComplete === 1 ? 1 : 0
    summary.dailyTechnical +=
      factors.dailyTechnicalAvailable === 1 ? 1 : 0
    summary.intradayTechnical +=
      factors.intradayTechnicalAvailable === 1 ? 1 : 0
    summary.sectorContext +=
      factors.sectorContextAvailable === 1 ? 1 : 0
    return summary
  }, {
    currentFund: 0,
    fundHistory: 0,
    completeFundHistory: 0,
    dailyTechnical: 0,
    intradayTechnical: 0,
    sectorContext: 0,
  })
  return {
    ...(Array.isArray(payload) ? {} : payload),
    schemaVersion: 'opportunity-outcome-export.v1',
    migratedAt: Date.now(),
    migration: {
      featureSchemaVersion: TARGET_SCHEMA,
      sourceSchemas: before,
      funds: fundRows.length,
      coverage,
    },
    outcomes: migrated,
  }
}

async function readJson(file) {
  const raw = await readFile(file)
  const decoded = file.endsWith('.gz') ? gunzipSync(raw) : raw
  return JSON.parse(decoded.toString('utf8'))
}

async function main() {
  const options = args(process.argv.slice(2))
  const [payload, funds, contract] = await Promise.all([
    readJson(options.input),
    readJson(options.funds),
    readJson(fileURLToPath(CONTRACT_PATH)),
  ])
  const migrated = migrateOpportunityHistoryV5(
    payload,
    funds,
    contract,
  )
  const temporary = `${options.output}.part`
  await mkdir(path.dirname(options.output), { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(migrated), { mode: 0o600 })
  await rename(temporary, options.output)
  process.stdout.write(`${JSON.stringify({
    output: options.output,
    outcomes: migrated.outcomes.length,
    ...migrated.migration,
  }, null, 2)}\n`)
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(SCRIPT)
) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`)
    process.exitCode = 1
  })
}
