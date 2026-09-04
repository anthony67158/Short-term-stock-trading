#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasStorage } from '../api/_blob.js'
import {
  opportunityRadarOutcomeStore,
} from '../api/_opportunity_radar_outcome_store.js'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

function safeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('机会结果导出日期范围无效')
  }
  return date
}

function dayOffset(day, offset) {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function utcDay() {
  return new Date().toISOString().slice(0, 10)
}

function safeOutcome(value) {
  if (
    value?.maturity !== 'MATURED'
    || !/^formula:/.test(String(value?.decisionId || ''))
    || !/^\d{6}$/.test(String(value?.code || ''))
    || ![
      'opportunity-score-feature.v1',
      'opportunity-score-feature.v2',
    ].includes(value?.scoreInput?.schemaVersion)
  ) return null
  return {
    schemaVersion: String(value.schemaVersion || ''),
    decisionId: String(value.decisionId),
    runId: String(value.runId || ''),
    tradeDate: String(value.tradeDate || ''),
    mode: String(value.mode || ''),
    slot: String(value.slot || ''),
    code: String(value.code),
    formulaId: String(value.formulaId || ''),
    maturity: 'MATURED',
    outcome: String(value.outcome || ''),
    fillStatus: String(value.fillStatus || ''),
    exitStatus: String(value.exitStatus || ''),
    scoreInput: value.scoreInput,
    metrics: value.metrics && typeof value.metrics === 'object'
      ? value.metrics
      : null,
    observations:
      value.observations && typeof value.observations === 'object'
        ? value.observations
        : null,
    context: value.context && typeof value.context === 'object'
      ? value.context
      : null,
  }
}

export function buildOpportunityOutcomeExport(
  outcomes,
  {
    from,
    to,
    exportedAt = Date.now(),
  } = {},
) {
  const start = safeDate(from)
  const end = safeDate(to)
  if (start > end) throw new Error('机会结果导出日期范围无效')
  const all = Array.isArray(outcomes) ? outcomes : []
  const projected = all
    .map(safeOutcome)
    .filter(Boolean)
    .sort((left, right) =>
      left.decisionId.localeCompare(right.decisionId),
    )
  return {
    schemaVersion: 'opportunity-outcome-export.v1',
    exportedAt: Number(exportedAt) || Date.now(),
    range: { from: start, to: end },
    summary: {
      requested: all.length,
      exported: projected.length,
      excluded: all.length - projected.length,
    },
    outcomes: projected,
  }
}

function args(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--from', '--to', '--output'].includes(key)) continue
    values[key.slice(2)] = argv[index + 1]
    index += 1
  }
  const to = values.to || utcDay()
  return {
    from: values.from || dayOffset(to, -180),
    to,
    output: path.resolve(
      values.output
      || path.join(
        ROOT,
        'qlib-service',
        'opportunity-outcomes.json',
      ),
    ),
  }
}

async function main() {
  const options = args(process.argv.slice(2))
  if (!hasStorage()) throw new Error('OSS 未配置，无法导出机会结果')
  const outcomes = await opportunityRadarOutcomeStore.listOutcomeRange({
    from: options.from,
    to: options.to,
    limit: 10000,
  })
  const exported = buildOpportunityOutcomeExport(outcomes, options)
  await mkdir(path.dirname(options.output), { recursive: true })
  await writeFile(
    options.output,
    JSON.stringify(exported, null, 2),
    'utf8',
  )
  process.stdout.write(JSON.stringify({
    ok: true,
    output: options.output,
    ...exported.summary,
  }) + '\n')
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`)
    process.exitCode = 1
  })
}
