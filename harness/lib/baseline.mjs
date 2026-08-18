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
  for (const run of runs || []) {
    const reference = baseline.suites?.[run.suiteId]
    if (!reference) {
      unbaselined.push(run.suiteId)
      continue
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
