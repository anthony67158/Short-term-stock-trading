import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA = 'harness-baseline.v1'
const DIMENSIONS = [
  'contract',
  'groundedness',
  'feasibility',
  'actionability',
  'consistency',
]

function round(value) {
  return +Number(value || 0).toFixed(4)
}

function rootPath(relativePath) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )
  const resolved = path.resolve(root, relativePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Harness基线路径越界')
  }
  return resolved
}

export function createHarnessBaseline(
  runs,
  {
    generatedAt = Date.now(),
    versions = {},
  } = {},
) {
  const suites = {}
  for (const run of runs || []) {
    if (!run?.suiteId || !run.summary) continue
    suites[run.suiteId] = {
      overall: round(run.summary.overall),
      dimensions: Object.fromEntries(
        DIMENSIONS.map((dimension) => [
          dimension,
          round(run.summary.dimensions?.[dimension]),
        ]),
      ),
      cases: Number(run.summary.total) || 0,
      caseIds: [...new Set(
        (run.episodes || [])
          .map((episode) => String(episode?.caseId || ''))
          .filter(Boolean),
      )].sort(),
    }
  }
  return {
    schemaVersion: SCHEMA,
    generatedAt,
    versions: { ...versions },
    suites,
  }
}

export function compareHarnessBaseline(
  runs,
  baseline,
  {
    overall = 0.03,
    dimension = 0.05,
    requireAllSuites = false,
  } = {},
) {
  if (!baseline || baseline.schemaVersion !== SCHEMA) {
    return {
      passed: false,
      regressions: [{
        suiteId: 'all',
        metric: 'baseline',
        current: null,
        baseline: null,
        tolerance: 0,
        delta: null,
        message: 'Harness基线缺失或版本无效',
      }],
      unbaselined: [],
    }
  }
  const regressions = []
  const unbaselined = []
  const currentSuiteIds = new Set(
    (runs || []).map((run) => run?.suiteId).filter(Boolean),
  )
  if (requireAllSuites) {
    for (const suiteId of Object.keys(baseline.suites || {})) {
      if (currentSuiteIds.has(suiteId)) continue
      regressions.push({
        suiteId,
        metric: 'suite',
        current: 0,
        baseline: 1,
        tolerance: 0,
        delta: -1,
        message: `${suiteId}基线suite未执行`,
      })
    }
  }
  for (const run of runs || []) {
    const reference = baseline.suites?.[run.suiteId]
    if (!reference) {
      unbaselined.push(run.suiteId)
      continue
    }
    const currentCases = Number(run.summary?.total) || 0
    const baselineCases = Number(reference.cases) || 0
    if (currentCases < baselineCases) {
      regressions.push({
        suiteId: run.suiteId,
        metric: 'cases',
        current: currentCases,
        baseline: baselineCases,
        tolerance: 0,
        delta: currentCases - baselineCases,
        message: `${run.suiteId}.cases由${baselineCases}减少到${currentCases}`,
      })
    }
    if (Array.isArray(reference.caseIds) && reference.caseIds.length) {
      const currentCaseIds = new Set(
        (run.episodes || [])
          .map((episode) => String(episode?.caseId || ''))
          .filter(Boolean),
      )
      const missing = reference.caseIds.filter(
        (caseId) => !currentCaseIds.has(caseId),
      )
      if (missing.length) {
        regressions.push({
          suiteId: run.suiteId,
          metric: 'caseIds',
          current: currentCaseIds.size,
          baseline: reference.caseIds.length,
          tolerance: 0,
          delta: -missing.length,
          message: `${run.suiteId}缺少基线case: ${missing.join(', ')}`,
        })
      }
    }
    const metrics = [
      ['overall', run.summary?.overall, reference.overall, overall],
      ...DIMENSIONS.map((name) => [
        name,
        run.summary?.dimensions?.[name],
        reference.dimensions?.[name],
        dimension,
      ]),
    ]
    for (const [metric, currentValue, baselineValue, tolerance] of metrics) {
      const current = round(currentValue)
      const expected = round(baselineValue)
      const delta = round(current - expected)
      if (delta >= -Number(tolerance || 0)) continue
      regressions.push({
        suiteId: run.suiteId,
        metric,
        current,
        baseline: expected,
        tolerance: round(tolerance),
        delta,
        message: `${run.suiteId}.${metric}较基线下降${Math.abs(delta)}`,
      })
    }
  }
  return {
    passed: regressions.length === 0 && unbaselined.length === 0,
    regressions,
    unbaselined,
  }
}

export async function loadHarnessBaseline(
  relativePath = 'baselines/current.json',
) {
  const parsed = JSON.parse(
    await readFile(rootPath(relativePath), 'utf8'),
  )
  if (parsed.schemaVersion !== SCHEMA) {
    throw new Error(`Harness基线schema必须为${SCHEMA}`)
  }
  return parsed
}

export async function writeHarnessBaseline(
  baseline,
  relativePath = 'baselines/current.json',
) {
  if (baseline?.schemaVersion !== SCHEMA) {
    throw new Error(`Harness基线schema必须为${SCHEMA}`)
  }
  const outputPath = rootPath(relativePath)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify(baseline, null, 2)}\n`,
  )
  return outputPath
}

export const HARNESS_BASELINE_SCHEMA = SCHEMA
