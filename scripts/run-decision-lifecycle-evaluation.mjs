#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runDecisionLifecycleHarnessCase,
} from '../harness/adapters/decision-lifecycle.mjs'
import {
  scoreHarnessChecks,
} from '../harness/lib/scorers.mjs'
import {
  validateHarnessCase,
} from '../harness/lib/loader.mjs'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const CASE_PATH = path.join(
  ROOT,
  'harness/cases/decision-lifecycle.json',
)
const OUTPUT_DIR = path.join(ROOT, 'docs/evaluation')
const OUTPUT_PATH = path.join(
  OUTPUT_DIR,
  'decision-lifecycle-results-20260830.json',
)
const WEIGHTS = {
  contract: 0.2,
  groundedness: 0.2,
  feasibility: 0.25,
  actionability: 0.2,
  consistency: 0.15,
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0)
    / values.length
}

function standardDeviation(values) {
  if (values.length <= 1) return 0
  const mean = average(values)
  const variance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / values.length
  return Math.sqrt(variance)
}

function rounded(value, digits = 4) {
  return +Number(value || 0).toFixed(digits)
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16)
}

function inferredSixDimensionScores({
  scored,
  evaluation,
  testCase,
}) {
  const actualSteps = Number(evaluation.metrics?.steps) || 0
  const optimalSteps = Number(testCase.optimal_steps) || 1
  const maxSteps = Number(testCase.max_acceptable_steps)
    || optimalSteps
  const routeCheck = evaluation.checks.find(
    (item) => item.id === 'lifecycle-llm-routing',
  )
  const recoveryCase = [
    'error_recovery',
    'adversarial',
  ].includes(testCase.eval_type)
  const safetyChecks = evaluation.checks.filter((item) =>
    item.hard === true
    && (
      item.id.includes('position')
      || item.id.includes('lots')
      || item.id.includes('t1')
      || item.id.includes('manual')
      || item.id.includes('idempotency')
      || item.id.includes('alert-cleanup')
      || item.id.includes('grounded')
    )
  )
  const taskCompletion = scored.passed ? 100 : (
    scored.overall >= 0.8 ? 80 : scored.overall >= 0.5 ? 50 : 0
  )
  const pathEfficiency = actualSteps <= optimalSteps
    ? 100
    : Math.max(
        0,
        100 * (1 - (actualSteps - optimalSteps) / optimalSteps),
      )
  const toolAccuracy = routeCheck?.passed === true ? 100 : 0
  const recoverability = recoveryCase
    ? scored.passed ? 100 : 0
    : 100
  const promptChars = (
    Number(evaluation.metrics?.advisorPromptLength) || 0
  ) + (
    Number(evaluation.metrics?.reviewPromptLength) || 0
  )
  const estimatedTokens = Math.ceil(promptChars / 2)
  const baselineTokens = Number(testCase.baseline_tokens) || 1
  const unitCost = Math.max(
    0,
    Math.min(100, 100 * baselineTokens / Math.max(
      baselineTokens,
      estimatedTokens,
    )),
  )
  const safety = safetyChecks.every((item) => item.passed)
    ? 100
    : 0
  const total = (
    taskCompletion * 0.25
    + pathEfficiency * 0.2
    + toolAccuracy * 0.2
    + recoverability * 0.15
    + unitCost * 0.1
    + safety * 0.1
  )
  return {
    taskCompletion: rounded(taskCompletion, 2),
    pathEfficiency: rounded(pathEfficiency, 2),
    toolAccuracy: rounded(toolAccuracy, 2),
    recoverability: rounded(recoverability, 2),
    unitCost: rounded(unitCost, 2),
    safety: rounded(safety, 2),
    total: rounded(total, 2),
    estimatedTokens,
    actualSteps,
    maxSteps,
  }
}

async function main() {
  const parsed = JSON.parse(await readFile(CASE_PATH, 'utf8'))
  const cases = parsed.cases.map(validateHarnessCase)
  const results = []

  for (const testCase of cases) {
    const samples = Math.max(
      5,
      Math.min(10, Number(testCase.sampling_count) || 5),
    )
    const scores = []
    const passes = []
    const durations = []
    const outputHashes = []
    let representative = null
    for (let index = 0; index < samples; index++) {
      const startedAt = performance.now()
      const evaluation = await runDecisionLifecycleHarnessCase(
        testCase,
      )
      const durationMs = performance.now() - startedAt
      const scored = scoreHarnessChecks(evaluation.checks, {
        weights: WEIGHTS,
        minOverall: Number(testCase.expect.minOverall) || 0.9,
      })
      const sixDimensions = inferredSixDimensionScores({
        scored,
        evaluation,
        testCase,
      })
      scores.push(sixDimensions.total)
      passes.push(scored.passed)
      durations.push(durationMs)
      outputHashes.push(fingerprint(evaluation.output))
      representative ||= {
        output: evaluation.output,
        checks: evaluation.checks,
        harnessScore: scored,
        sixDimensions,
      }
    }
    const mean = average(scores)
    const std = standardDeviation(scores)
    const standardError = std / Math.sqrt(samples)
    results.push({
      caseId: testCase.id,
      module: testCase.module || '决策链',
      evalType: testCase.eval_type || 'functional',
      judgeMethod: testCase.judge_method || 'auto_assert',
      difficulty: testCase.difficulty || 'L2',
      samples,
      passCount: passes.filter(Boolean).length,
      deterministic:
        new Set(outputHashes).size === 1,
      score: {
        mean: rounded(mean, 2),
        std: rounded(std, 2),
        min: rounded(Math.min(...scores), 2),
        max: rounded(Math.max(...scores), 2),
        confidence95: [
          rounded(mean - 1.96 * standardError, 2),
          rounded(mean + 1.96 * standardError, 2),
        ],
      },
      durationMs: {
        mean: rounded(average(durations), 3),
        max: rounded(Math.max(...durations), 3),
      },
      ...representative,
    })
  }

  const dimensions = [
    'taskCompletion',
    'pathEfficiency',
    'toolAccuracy',
    'recoverability',
    'unitCost',
    'safety',
  ]
  const summary = {
    cases: results.length,
    samples: results.reduce(
      (sum, result) => sum + result.samples,
      0,
    ),
    passedCases: results.filter(
      (result) => result.passCount === result.samples,
    ).length,
    deterministicCases: results.filter(
      (result) => result.deterministic,
    ).length,
    meanScore: rounded(average(
      results.map((result) => result.score.mean),
    ), 2),
    dimensions: Object.fromEntries(
      dimensions.map((dimension) => [
        dimension,
        rounded(average(
          results.map(
            (result) =>
              result.sixDimensions[dimension],
          ),
        ), 2),
      ]),
    ),
  }
  const report = {
    schemaVersion: 'decision-lifecycle-evaluation.v1',
    generatedAt: new Date().toISOString(),
    sourceCaseFile: path.relative(ROOT, CASE_PATH),
    offline: true,
    paidModelCalls: 0,
    productionWrites: 0,
    summary,
    findings: [
      {
        id: 'F-001',
        severity: 'high',
        status: 'fixed',
        title: '触价买入JSON在字段映射前被普通校验误降级',
      },
      {
        id: 'F-002',
        severity: 'high',
        status: 'fixed',
        title: '加仓快速复核没有继承原计划止损和目标',
      },
      {
        id: 'F-003',
        severity: 'high',
        status: 'fixed',
        title: 'T+1减仓受阻后仍可能生成方向相反的加仓观察提醒',
      },
      {
        id: 'F-004',
        severity: 'medium',
        status: 'fixed',
        title: '带T+1上下文的持仓预警可能丢失股票名称',
      },
      {
        id: 'F-005',
        severity: 'medium',
        status: 'fixed',
        title: '统一复核输入包遗漏完整短线动作政策',
      },
      {
        id: 'F-006',
        severity: 'high',
        status: 'fixed',
        title: '原计划5%仓位上限只进入文字提示，未硬限制复核手数',
      },
    ],
    results,
  }
  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(report, null, 2)}\n`,
  )
  if (summary.passedCases !== summary.cases) {
    throw new Error(
      `决策链评测未通过: ${summary.passedCases}/${summary.cases}`,
    )
  }
  process.stdout.write(
    `Decision lifecycle evaluation PASS: `
    + `${summary.passedCases}/${summary.cases} cases, `
    + `${summary.samples} samples, `
    + `score=${summary.meanScore}\n`
    + `${OUTPUT_PATH}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`)
  process.exitCode = 1
})
