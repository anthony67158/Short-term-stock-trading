#!/usr/bin/env node

import {
  loadHarnessCases,
  loadHarnessManifest,
} from './lib/loader.mjs'
import {
  harnessFingerprint,
  runHarnessSuite,
} from './lib/runner.mjs'
import {
  renderHarnessMarkdown,
  sanitizeHarnessValue,
  writeHarnessReports,
} from './lib/reporter.mjs'
import {
  runPortfolioHarnessCase,
} from './adapters/portfolio.mjs'
import {
  runEvidenceHarnessCase,
} from './adapters/evidence.mjs'
import {
  runAdviceHarnessCase,
} from './adapters/advice.mjs'
import {
  runJudgeHarnessCase,
} from './adapters/judge.mjs'
import {
  runScreenHarnessCase,
} from './adapters/screen.mjs'
import {
  runDailyHarnessCase,
} from './adapters/daily.mjs'
import {
  runEndpointHarnessCase,
} from './adapters/endpoint.mjs'
import {
  runShadowHarnessCase,
} from './adapters/shadow.mjs'
import {
  runSectorHarnessCase,
} from './adapters/sector.mjs'
import {
  compareHarnessBaseline,
  createHarnessBaseline,
  loadHarnessBaseline,
  writeHarnessBaseline,
} from './lib/baseline.mjs'

const ADAPTERS = {
  portfolio: runPortfolioHarnessCase,
  evidence: runEvidenceHarnessCase,
  advice: runAdviceHarnessCase,
  judge: runJudgeHarnessCase,
  screen: runScreenHarnessCase,
  daily: runDailyHarnessCase,
  endpoint: runEndpointHarnessCase,
  shadow: runShadowHarnessCase,
  sector: runSectorHarnessCase,
}

function parseArgs(argv) {
  const options = {
    suite: 'all',
    format: 'text',
    write: true,
    manifest: 'manifest.json',
    caseFile: '',
    baseline: '',
    compareBaseline: true,
    updateBaseline: false,
    online: false,
    outputDir: 'harness-artifacts',
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--no-write') {
      options.write = false
    } else if (arg === '--suite') {
      options.suite = argv[++index] || ''
    } else if (arg === '--format') {
      options.format = argv[++index] || ''
    } else if (arg === '--manifest') {
      options.manifest = argv[++index] || ''
    } else if (arg === '--case-file') {
      options.caseFile = argv[++index] || ''
    } else if (arg === '--baseline') {
      options.baseline = argv[++index] || ''
    } else if (arg === '--no-baseline') {
      options.compareBaseline = false
    } else if (arg === '--update-baseline') {
      options.updateBaseline = true
    } else if (arg === '--online') {
      options.online = true
    } else if (arg === '--output-dir') {
      options.outputDir = argv[++index] || ''
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知Harness参数: ${arg}`)
    }
  }
  if (!['text', 'json', 'markdown'].includes(options.format)) {
    throw new Error('Harness format仅支持text/json/markdown')
  }
  return options
}

function aggregateRuns(runs, generatedAt = Date.now()) {
  const episodes = runs.flatMap((run) => run.episodes)
  const dimensions = {}
  const dimensionNames = [
    'contract',
    'groundedness',
    'feasibility',
    'actionability',
    'consistency',
  ]
  for (const dimension of dimensionNames) {
    dimensions[dimension] = episodes.length
      ? +(
          episodes.reduce(
            (sum, episode) =>
              sum + Number(episode.scores?.[dimension] || 0),
            0,
          ) / episodes.length
        ).toFixed(4)
      : 0
  }
  const passed = episodes.filter(
    (episode) => episode.status === 'PASS',
  ).length
  return {
    schemaVersion: 'harness-run.v1',
    runId: harnessFingerprint('run', {
      generatedAt,
      suites: runs.map((run) => run.runId),
    }),
    suiteId: runs.length === 1 ? runs[0].suiteId : 'all',
    generatedAt,
    ok: runs.length > 0 && runs.every((run) => run.ok),
    summary: {
      total: episodes.length,
      passed,
      failed: episodes.length - passed,
      passRate: episodes.length
        ? +(passed / episodes.length).toFixed(4)
        : 0,
      overall: episodes.length
        ? +(
            episodes.reduce(
              (sum, episode) =>
                sum + Number(episode.scores?.overall || 0),
              0,
            ) / episodes.length
          ).toFixed(4)
        : 0,
      dimensions,
      durationMs: runs.reduce(
        (sum, run) =>
          sum + Number(run.summary?.durationMs || 0),
        0,
      ),
    },
    episodes,
  }
}

function textSummary(run) {
  const status = run.ok ? 'PASS' : 'FAIL'
  const lines = [
    `Harness ${status}`,
    `suite=${run.suiteId}`,
    `cases=${run.summary.passed}/${run.summary.total}`,
    `overall=${run.summary.overall.toFixed(4)}`,
  ]
  if (run.baseline && !run.baseline.skipped) {
    lines.push(
      `baseline=${run.baseline.passed ? 'PASS' : 'FAIL'} regressions=${run.baseline.regressions?.length || 0}`,
    )
  }
  for (const episode of run.episodes) {
    const failures = episode.failures
      .map((failure) => failure.code)
      .join(',')
    lines.push(
      `${episode.status} ${episode.caseId} score=${episode.scores.overall.toFixed(4)}${failures ? ` failures=${failures}` : ''}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export async function runHarnessCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    return {
      exitCode: 0,
      output: [
        'Usage: node harness/run.mjs [options]',
        '  --suite <id|all>',
        '  --format <text|json|markdown>',
        '  --manifest <relative path>',
        '  --case-file <relative path>',
        '  --baseline <relative path>',
        '  --no-baseline',
        '  --update-baseline',
        '  --online',
        '  --output-dir <path>',
        '  --no-write',
      ].join('\n') + '\n',
      run: null,
    }
  }
  const manifest = await loadHarnessManifest(options.manifest)
  const suiteIds = options.suite === 'all'
    ? Object.entries(manifest.suites)
      .filter(([, suite]) =>
        options.online || suite.mode !== 'online'
      )
      .map(([suiteId]) => suiteId)
    : [options.suite]
  const onlineSuites = suiteIds.filter(
    (suiteId) => manifest.suites[suiteId]?.mode === 'online',
  )
  if (onlineSuites.length && !options.online) {
    throw new Error(
      `在线suite需要显式--online: ${onlineSuites.join(',')}`,
    )
  }
  if (options.caseFile && suiteIds.length !== 1) {
    throw new Error('--case-file必须同时指定单一--suite')
  }
  if (
    options.updateBaseline
    && (
      options.suite !== 'all'
      || !!options.caseFile
      || onlineSuites.length > 0
    )
  ) {
    throw new Error(
      '基线更新必须运行全部离线suite，禁止单suite、在线suite或临时case',
    )
  }
  const runs = []
  for (const suiteId of suiteIds) {
    const suite = manifest.suites[suiteId]
    if (!suite) throw new Error(`Harness suite不存在: ${suiteId}`)
    const cases = await loadHarnessCases(
      options.caseFile || suite.caseFile,
    )
    runs.push(await runHarnessSuite({
      manifest,
      suiteId,
      cases,
      adapters: ADAPTERS,
    }))
  }
  if (options.updateBaseline && !runs.every((run) => run.ok)) {
    throw new Error('存在失败的离线suite，拒绝更新Harness基线')
  }
  const run = aggregateRuns(runs)
  run.versions = {
    app: process.env.npm_package_version || '1.0.0',
    git: process.env.GITHUB_SHA
      || process.env.HARNESS_GIT_SHA
      || 'working-tree',
    node: process.version,
    adapters: [...new Set(
      run.episodes.map((episode) => episode.adapter),
    )].sort(),
  }
  const baselinePath = options.baseline
    || manifest.baselineFile
    || 'baselines/current.json'
  if (options.updateBaseline) {
    const baseline = createHarnessBaseline(runs, {
      generatedAt: run.generatedAt,
      versions: run.versions,
    })
    await writeHarnessBaseline(baseline, baselinePath)
  }
  if (
    options.compareBaseline
    && !options.caseFile
    && onlineSuites.length === 0
  ) {
    const baseline = await loadHarnessBaseline(baselinePath)
    run.baseline = {
      path: baselinePath,
      ...compareHarnessBaseline(
        runs,
        baseline,
        manifest.regressionTolerance || {},
      ),
      versions: baseline.versions || {},
    }
    if (!run.baseline.passed) run.ok = false
  } else {
    run.baseline = {
      skipped: true,
      reason: options.caseFile
        ? 'ad-hoc-case'
        : onlineSuites.length
          ? 'online-suite'
          : 'disabled',
    }
  }
  if (options.write) {
    await writeHarnessReports(run, {
      outputDir: options.outputDir,
    })
  }
  const safe = sanitizeHarnessValue(run)
  const output = options.format === 'json'
    ? `${JSON.stringify(safe, null, 2)}\n`
    : options.format === 'markdown'
      ? renderHarnessMarkdown(safe)
      : textSummary(safe)
  return {
    exitCode: run.ok ? 0 : 1,
    output,
    run: safe,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runHarnessCli()
    process.stdout.write(result.output)
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(
      `Harness ERROR: ${String(error?.message || error)}\n`,
    )
    process.exitCode = 1
  }
}
