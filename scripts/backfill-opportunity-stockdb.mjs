#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  gunzip,
  gzip,
} from 'node:zlib'

import {
  createStockDbHttpClient,
} from './lib/stockdb-http.mjs'
import {
  StockDbHistorySource,
  indexRowsByCode,
} from './lib/stockdb-history-source.mjs'
import {
  buildMinuteExportManifest,
  selectCausalUniverse,
  selectReplayDates,
} from './lib/stockdb-backfill-plan.mjs'
import {
  appendBarsForCodes,
  beijingSlotTimestamp,
  groupMinuteRows,
  pendingFromBatch,
  scanHistoricalSlot,
  settlePendingHistoricalEvents,
} from './lib/stockdb-backfill-runtime.mjs'
import {
  mergeHistoricalOutcomes,
} from './lib/opportunity-history-backfill.mjs'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')
const DEFAULT_STOCKDB_ROOT = path.join(
  os.homedir(),
  '.stockdb-v0.3.5-run',
)
const DEFAULT_WORK_DIR = path.join(
  os.homedir(),
  '.stockdb-v3-work',
)
const DEFAULT_TUSHARE_WORK_DIR = path.join(
  os.homedir(),
  '.tushare-v3-work',
)
const SLOT_CONFIG = Object.freeze([
  { mode: 'intraday', slot: '1020' },
  { mode: 'intraday', slot: '1340' },
  { mode: 'close', slot: '1510' },
])

function beijingDay() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()).replaceAll('-', '')
}

function dayOffset(day, offset) {
  const date = new Date(
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}T00:00:00Z`,
  )
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function positiveInteger(value, fallback, maximum) {
  const number = Math.trunc(Number(value))
  return Number.isFinite(number) && number > 0
    ? Math.min(number, maximum)
    : fallback
}

export function parseStockDbBackfillArgs(argv = []) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name.startsWith('--')) continue
    const key = name.slice(2)
    if (![
      'provider',
      'stockdb-root',
      'work-dir',
      'base-url',
      'from',
      'to',
      'signal-days',
      'universe-size',
      'max-per-min',
    ].includes(key)) {
      throw new Error(`未知StockDB回填参数: ${name}`)
    }
    values[key] = argv[index + 1]
    index += 1
  }
  const to = String(values.to || beijingDay()).replaceAll('-', '')
  const from = String(values.from || dayOffset(to, -300)).replaceAll('-', '')
  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to) || from >= to) {
    throw new Error('StockDB回填日期范围无效')
  }
  const provider = String(values.provider || 'stockdb').toLowerCase()
  if (!['stockdb', 'tushare', 'archive'].includes(provider)) {
    throw new Error('历史回填数据源无效')
  }
  return {
    provider,
    stockdbRoot: path.resolve(values['stockdb-root'] || DEFAULT_STOCKDB_ROOT),
    workDir: path.resolve(
      values['work-dir']
      || (
        provider === 'tushare'
          ? DEFAULT_TUSHARE_WORK_DIR
          : DEFAULT_WORK_DIR
      ),
    ),
    baseUrl: values['base-url'] || 'http://127.0.0.1:7899',
    from,
    to,
    signalDays: positiveInteger(values['signal-days'], 90, 120),
    universeSize: positiveInteger(values['universe-size'], 1000, 2000),
    maxPerMinute: positiveInteger(values['max-per-min'], 90, 120),
  }
}

export function filterStockDbRowsByRange(rows, from, to) {
  return (Array.isArray(rows) ? rows : []).filter(
    (row) => row?.date >= from && row?.date <= to,
  )
}

export function replayDatesFromManifest(manifest = {}) {
  if (!Array.isArray(manifest.dates) || !manifest.dates.length) {
    throw new Error('StockDB分钟导出清单不含可回放日期')
  }
  const dates = manifest.dates.map((row) => String(row?.date || ''))
  if (
    dates.some((date) => !/^\d{8}$/.test(date))
    || new Set(dates).size !== dates.length
  ) {
    throw new Error('StockDB分钟导出清单日期无效')
  }
  return dates
}

function assertDisposableDirectory(directory) {
  const home = os.homedir()
  if (
    !directory.startsWith(`${home}${path.sep}`)
    || directory === home
    || directory.startsWith(`${ROOT}${path.sep}`)
  ) {
    throw new Error('StockDB回填工作目录必须位于项目外的用户目录')
  }
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function writeGzipJson(file, value) {
  const temporary = `${file}.part`
  const encoded = Buffer.from(JSON.stringify(value))
  const compressed = await gzipAsync(encoded, { level: 6 })
  try {
    await writeFile(temporary, compressed, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    encoded.fill(0)
    compressed.fill(0)
  }
}

async function readGzipJson(file) {
  const compressed = await readFile(file)
  const decoded = await gunzipAsync(compressed)
  try {
    return JSON.parse(decoded.toString('utf8'))
  } finally {
    compressed.fill(0)
    decoded.fill(0)
  }
}

async function cachedJson(file, loader) {
  if (await fileExists(file)) return readGzipJson(file)
  const value = await loader()
  await writeGzipJson(file, value)
  return value
}

function writeProgress(stage, details = {}) {
  process.stdout.write(JSON.stringify({
    at: new Date().toISOString(),
    stage,
    ...details,
  }) + '\n')
}

function validateCoverage(daily, funds, plan, universeSize) {
  const dailyCodes = new Set(daily.map((row) => row.code))
  const fundDates = new Set(funds.map((row) => row.date))
  if (dailyCodes.size < Math.min(800, universeSize)) {
    throw new Error(`StockDB有效股票不足800只: ${dailyCodes.size}`)
  }
  if (plan.signalDates.length < 60) {
    throw new Error(`StockDB有效训练日期不足60日: ${plan.signalDates.length}`)
  }
  if (fundDates.size < 60) {
    throw new Error(`StockDB资金流有效日期不足60日: ${fundDates.size}`)
  }
}

async function runPythonExporter(arguments_, label) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', arguments_, {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(
        `${label}失败: ${signal || code}`,
      ))
    })
  })
}

async function runTushareMetadataExporter(options) {
  return runPythonExporter([
    path.join(ROOT, 'scripts', 'tushare_export_history.py'),
    '--stage',
    'metadata',
    '--work-dir',
    options.workDir,
    '--from',
    options.from,
    '--to',
    options.to,
    '--max-per-min',
    String(options.maxPerMinute),
  ], 'Tushare历史元数据导出')
}

async function runTushareSectorExporter(output) {
  return runPythonExporter([
    path.join(
      ROOT,
      'qlib-service',
      'archive_tushare_sector_membership.py',
    ),
    '--output',
    output,
  ], 'Tushare历史行业成员导出')
}

async function runArchiveExporter(options) {
  return runPythonExporter([
    path.join(
      ROOT,
      'qlib-service',
      'export_opportunity_market_archive.py',
    ),
    '--work-dir',
    options.workDir,
    '--from',
    options.from,
    '--to',
    options.to,
    '--max-per-min',
    String(options.maxPerMinute),
  ], 'OSS市场归档导出')
}

async function runMinuteExporter(options, manifestPath, minuteDirectory) {
  if (options.provider === 'tushare') {
    return runPythonExporter([
      path.join(ROOT, 'scripts', 'tushare_export_history.py'),
      '--stage',
      'minutes',
      '--work-dir',
      options.workDir,
      '--manifest',
      manifestPath,
      '--output-dir',
      minuteDirectory,
      '--max-per-min',
      String(options.maxPerMinute),
    ], 'Tushare分钟导出')
  }
  return runPythonExporter([
    path.join(ROOT, 'scripts', 'stockdb_export_minutes.py'),
    '--manifest',
    manifestPath,
    '--stockdb-root',
    options.stockdbRoot,
    '--output-dir',
    minuteDirectory,
  ], 'StockDB分钟导出')
}

function minuteMap(payload) {
  const values = payload?.codes
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('StockDB分钟缓存结构无效')
  }
  const result = new Map()
  for (const [code, rows] of Object.entries(values)) {
    const grouped = groupMinuteRows(rows)
    result.set(code, grouped.get(code) || [])
  }
  return result
}

function pruneBars(barsByCode, pending) {
  const active = new Set(pending.map((item) => item.event.code))
  for (const code of barsByCode.keys()) {
    if (!active.has(code)) barsByCode.delete(code)
  }
}

async function loadExistingOutcomes() {
  const file = path.join(
    ROOT,
    'qlib-service',
    'opportunity-outcomes.json',
  )
  if (!await fileExists(file)) return []
  const payload = JSON.parse(await readFile(file, 'utf8'))
  return Array.isArray(payload) ? payload : payload.outcomes || []
}

async function main() {
  const options = parseStockDbBackfillArgs(process.argv.slice(2))
  assertDisposableDirectory(options.workDir)
  await mkdir(options.workDir, { recursive: true, mode: 0o700 })
  const minuteDirectory = path.join(options.workDir, 'minutes')
  await mkdir(minuteDirectory, { recursive: true, mode: 0o700 })
  const dailyFile = path.join(options.workDir, 'daily.json.gz')
  const fundFile = path.join(options.workDir, 'funds.json.gz')
  const sectorFile = path.join(
    options.workDir,
    'sector-membership.json.gz',
  )
  writeProgress('DAILY_START', { from: options.from, to: options.to })
  let cachedDaily
  let cachedFunds
  if (options.provider === 'archive') {
    await runArchiveExporter(options)
    cachedDaily = await readGzipJson(dailyFile)
    cachedFunds = await readGzipJson(fundFile)
  } else if (options.provider === 'tushare') {
    await runTushareMetadataExporter(options)
    if (!await fileExists(sectorFile)) {
      await runTushareSectorExporter(sectorFile)
    }
    cachedDaily = await readGzipJson(dailyFile)
    cachedFunds = await readGzipJson(fundFile)
  } else {
    const client = createStockDbHttpClient({
      baseUrl: options.baseUrl,
      timeoutMs: 300_000,
    })
    const source = new StockDbHistorySource(client)
    cachedDaily = await cachedJson(
      dailyFile,
      () => source.dailyRange(options.from, options.to),
    )
    cachedFunds = await cachedJson(
      fundFile,
      () => source.fundRange(options.from, options.to),
    )
  }
  const daily = filterStockDbRowsByRange(
    cachedDaily,
    options.from,
    options.to,
  )
  writeProgress('FUND_START', { dailyRows: daily.length })
  const funds = filterStockDbRowsByRange(
    cachedFunds,
    options.from,
    options.to,
  )
  const dailyByCode = indexRowsByCode(daily)
  const fundByCode = indexRowsByCode(funds)
  const sectorMemberships = await fileExists(sectorFile)
    ? (await readGzipJson(sectorFile)).memberships || []
    : []
  const plan = selectReplayDates(daily, {
    signalDays: options.signalDays,
    settlementDays: options.provider === 'archive' ? 6 : 7,
  })
  validateCoverage(daily, funds, plan, options.universeSize)
  const universesByDate = new Map()
  for (const date of plan.signalDates) {
    universesByDate.set(date, selectCausalUniverse(
      dailyByCode,
      date,
      { limit: options.universeSize },
    ))
  }
  const manifest = buildMinuteExportManifest({
    processingDates: plan.processingDates,
    signalDates: plan.signalDates,
    universesByDate,
  })
  const manifestPath = path.join(options.workDir, 'minute-manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  )
  writeProgress('MINUTE_EXPORT_START', {
    signalDates: plan.signalDates.length,
    processingDates: manifest.dates.length,
    maximumCodes: Math.max(...manifest.dates.map((row) => row.codes.length)),
  })
  if (options.provider !== 'archive') {
    await runMinuteExporter(options, manifestPath, minuteDirectory)
  }

  const sourceType = {
    tushare: 'TUSHARE_CAUSAL_REPLAY',
    archive: 'OSS_MARKET_CAUSAL_REPLAY',
  }[options.provider] || 'STOCKDB_CAUSAL_REPLAY'
  const replayDates = replayDatesFromManifest(manifest)
  const signalSet = new Set(plan.signalDates)
  const barsByCode = new Map()
  const outcomes = []
  let pending = []
  let batchCount = 0
  let eventCount = 0
  for (let index = 0; index < replayDates.length; index += 1) {
    const tradeDate = replayDates[index]
    const file = path.join(minuteDirectory, `${tradeDate}.json.gz`)
    const minutesByCode = minuteMap(await readGzipJson(file))
    const appendedToday = new Set(
      pending.map((item) => item.event.code),
    )
    appendBarsForCodes(barsByCode, minutesByCode, appendedToday)
    if (signalSet.has(tradeDate)) {
      const universeCodes = universesByDate.get(tradeDate) || []
      for (const config of SLOT_CONFIG) {
        const batch = await scanHistoricalSlot({
          tradeDate,
          ...config,
          source: sourceType,
          universeCodes,
          minutesByCode,
          dailyByCode,
          fundByCode,
          sectorMemberships,
        })
        const next = pendingFromBatch(batch)
        const newCodes = new Set(next.map((item) => item.event.code))
        appendBarsForCodes(
          barsByCode,
          minutesByCode,
          [...newCodes].filter((code) => !appendedToday.has(code)),
        )
        newCodes.forEach((code) => appendedToday.add(code))
        pending.push(...next)
        batchCount += 1
        eventCount += next.length
      }
    }
    const settled = settlePendingHistoricalEvents({
      pending,
      barsByCode,
      evaluatedAt: beijingSlotTimestamp(tradeDate, '1600'),
    })
    outcomes.push(...settled.matured)
    pending = settled.pending
    pruneBars(barsByCode, pending)
    writeProgress('REPLAY_DAY', {
      progress: index + 1,
      total: replayDates.length,
      tradeDate,
      batches: batchCount,
      events: eventCount,
      matured: outcomes.length,
      pending: pending.length,
    })
  }

  const existing = options.provider === 'archive'
    ? []
    : await loadExistingOutcomes()
  const merged = mergeHistoricalOutcomes(outcomes, existing)
  const output = {
    schemaVersion: 'opportunity-outcome-export.v1',
    exportedAt: Date.now(),
    range: {
      from: displayDate(plan.signalDates[0]),
      to: displayDate(plan.signalDates.at(-1)),
    },
    source: {
      type: sourceType,
      version: options.provider === 'tushare'
        ? 'proxy-v1'
        : options.provider === 'archive'
          ? 'market-data-v1'
          : '0.3.5',
      signalDates: plan.signalDates.length,
      universeSize: options.universeSize,
      batches: batchCount,
    },
    summary: {
      existing: existing.length,
      historical: outcomes.length,
      merged: merged.length,
      pending: pending.length,
    },
    outcomes: merged,
  }
  const outputPath = path.join(
    options.workDir,
    'opportunity-outcomes-combined.json',
  )
  await writeFile(
    outputPath,
    JSON.stringify(output),
    { mode: 0o600 },
  )
  writeProgress('DONE', { output: outputPath, ...output.summary })
}

function displayDate(value) {
  const date = String(value || '')
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
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
