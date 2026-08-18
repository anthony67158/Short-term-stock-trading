import { createHash } from 'node:crypto'

import {
  validateHarnessCase,
  validateHarnessManifest,
} from './loader.mjs'
import {
  HARNESS_SCORE_DIMENSIONS,
  scoreHarnessChecks,
} from './scorers.mjs'

const RUN_SCHEMA = 'harness-run.v1'
const EPISODE_SCHEMA = 'harness-episode.v1'

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    )
  }
  return value ?? null
}

function fingerprint(prefix, value) {
  const digest = createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
    .slice(0, 16)
  return `${prefix}.${digest}`
}

function average(values) {
  if (!values.length) return 0
  return +(
    values.reduce((sum, value) => sum + Number(value || 0), 0)
    / values.length
  ).toFixed(4)
}

function stage(name, status, startedAt, finishedAt, details) {
  return {
    name,
    status,
    durationMs: Math.max(0, finishedAt - startedAt),
    ...(details ? { details } : {}),
  }
}

export async function runHarnessSuite({
  manifest,
  suiteId,
  cases,
  adapters,
  now = Date.now,
} = {}) {
  const validatedManifest = validateHarnessManifest(manifest)
  const suite = validatedManifest.suites[suiteId]
  if (!suite) throw new Error(`Harness suite不存在: ${suiteId}`)
  const adapter = adapters?.[suite.adapter]
  if (typeof adapter !== 'function') {
    throw new Error(`Harness adapter未注册: ${suite.adapter}`)
  }
  const runStartedAt = now()
  const episodes = []
  for (const rawCase of cases || []) {
    const stages = []
    const loadStartedAt = now()
    const testCase = validateHarnessCase(rawCase)
    if (testCase.adapter !== suite.adapter) {
      throw new Error(
        `Harness case ${testCase.id} adapter与suite不一致`,
      )
    }
    const inputFingerprint = fingerprint('input', testCase.input)
    stages.push(stage('load', 'PASS', loadStartedAt, now()))
    const executeStartedAt = now()
    try {
      const evaluation = await adapter(testCase)
      stages.push(stage('execute', 'PASS', executeStartedAt, now()))
      const scoreStartedAt = now()
      const minOverall = Math.max(
        Number(validatedManifest.defaults?.minOverall || 0),
        Number(suite.minOverall || 0),
        Number(testCase.expect?.minOverall || 0),
      )
      const scored = scoreHarnessChecks(evaluation.checks, {
        weights: validatedManifest.dimensions,
        minOverall,
      })
      stages.push(stage('score', scored.passed ? 'PASS' : 'FAIL', scoreStartedAt, now()))
      episodes.push({
        schemaVersion: EPISODE_SCHEMA,
        suiteId,
        caseId: testCase.id,
        adapter: suite.adapter,
        inputFingerprint,
        status: scored.passed ? 'PASS' : 'FAIL',
        stages,
        scores: Object.fromEntries([
          ...HARNESS_SCORE_DIMENSIONS.map(
            (dimension) => [dimension, scored[dimension]],
          ),
          ['overall', scored.overall],
        ]),
        thresholds: {
          minOverall,
        },
        failures: scored.failures,
        checks: scored.checks,
        output: evaluation.output,
        metrics: {
          ...(evaluation.metrics || {}),
          durationMs: Math.max(0, now() - executeStartedAt),
        },
      })
    } catch (error) {
      stages.push(stage(
        'execute',
        'ERROR',
        executeStartedAt,
        now(),
        { errorType: error?.name || 'Error' },
      ))
      episodes.push({
        schemaVersion: EPISODE_SCHEMA,
        suiteId,
        caseId: testCase.id,
        adapter: suite.adapter,
        inputFingerprint,
        status: 'ERROR',
        stages,
        scores: Object.fromEntries([
          ...HARNESS_SCORE_DIMENSIONS.map(
            (dimension) => [dimension, 0],
          ),
          ['overall', 0],
        ]),
        thresholds: {
          minOverall: Number(suite.minOverall || 0),
        },
        failures: [{
          code: 'ADAPTER_ERROR',
          dimension: 'contract',
          message: String(error?.message || error).slice(0, 300),
          hard: true,
          details: null,
        }],
        checks: [],
        output: null,
        metrics: {
          durationMs: Math.max(0, now() - executeStartedAt),
        },
      })
    }
  }
  const passed = episodes.filter(
    (episode) => episode.status === 'PASS',
  ).length
  const dimensions = Object.fromEntries(
    HARNESS_SCORE_DIMENSIONS.map((dimension) => [
      dimension,
      average(episodes.map((episode) => episode.scores[dimension])),
    ]),
  )
  const generatedAt = now()
  const summary = {
    total: episodes.length,
    passed,
    failed: episodes.length - passed,
    passRate: episodes.length
      ? +(passed / episodes.length).toFixed(4)
      : 0,
    overall: average(
      episodes.map((episode) => episode.scores.overall),
    ),
    dimensions,
    durationMs: Math.max(0, generatedAt - runStartedAt),
  }
  return {
    schemaVersion: RUN_SCHEMA,
    runId: fingerprint('run', {
      suiteId,
      generatedAt,
      inputs: episodes.map(
        (episode) => episode.inputFingerprint,
      ),
    }),
    suiteId,
    generatedAt,
    ok: episodes.length > 0 && passed === episodes.length,
    summary,
    episodes,
  }
}

export function harnessFingerprint(prefix, value) {
  return fingerprint(prefix, value)
}
