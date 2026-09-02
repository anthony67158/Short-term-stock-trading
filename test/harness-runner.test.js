import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  validateHarnessCase,
  validateHarnessManifest,
} from '../harness/lib/loader.mjs'
import { scoreHarnessChecks } from '../harness/lib/scorers.mjs'
import { runHarnessSuite } from '../harness/lib/runner.mjs'
import {
  renderHarnessMarkdown,
  sanitizeHarnessValue,
} from '../harness/lib/reporter.mjs'
import { runPortfolioHarnessCase } from '../harness/adapters/portfolio.mjs'
import { runHarnessCli } from '../harness/run.mjs'
import {
  createRegressionCase,
  serializeRegressionCaseSet,
} from '../harness/lib/exporter.mjs'
import { exportHarnessFailure } from '../harness/export.mjs'
import {
  compareHarnessBaseline,
  createHarnessBaseline,
} from '../harness/lib/baseline.mjs'
import {
  runEndpointHarnessCase,
} from '../harness/adapters/endpoint.mjs'
import {
  runShadowHarnessCase,
} from '../harness/adapters/shadow.mjs'

const packageJson = JSON.parse(readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
))
const workflow = readFileSync(
  new URL('../.github/workflows/harness-ci.yml', import.meta.url),
  'utf8',
)
const gitignore = readFileSync(
  new URL('../.gitignore', import.meta.url),
  'utf8',
)
const onlineAdviceHarness = readFileSync(
  new URL('../scripts/advice-reliability-harness.mjs', import.meta.url),
  'utf8',
)
const buildFcPackage = readFileSync(
  new URL('../scripts/build-fc-package.mjs', import.meta.url),
  'utf8',
)
const fcRuntimePackage = JSON.parse(readFileSync(
  new URL('../fc-runtime/package.json', import.meta.url),
  'utf8',
))
const fcRuntimeLock = readFileSync(
  new URL('../fc-runtime/package-lock.json', import.meta.url),
  'utf8',
)

const weights = {
  contract: 0.2,
  groundedness: 0.2,
  feasibility: 0.25,
  actionability: 0.2,
  consistency: 0.15,
}

const manifest = {
  schemaVersion: 'harness-manifest.v1',
  dimensions: weights,
  defaults: {
    minOverall: 0.85,
  },
  suites: {
    portfolio: {
      adapter: 'portfolio',
      caseFile: 'cases/portfolio.json',
      minOverall: 0.9,
    },
  },
}

function passingCase() {
  return {
    schemaVersion: 'harness-case.v1',
    id: 'portfolio-pass',
    adapter: 'portfolio',
    tags: ['portfolio', 'grounding'],
    input: {
      distribution: {
        totalAssets: 100000,
        investedValue: 78000,
        cash: 22000,
        positionPct: 78,
        cashReservePct: 22,
        groups: [
          {
            name: 'PCB',
            accountWeightPct: 48,
            holdingWeightPct: 61.54,
          },
          {
            name: '创新药',
            accountWeightPct: 30,
            holdingWeightPct: 38.46,
          },
        ],
        stocks: [
          {
            code: '300476',
            name: '胜宏科技',
            concept: 'PCB',
            qty: 5,
            sellableQty: 3,
            price: 90,
            marketValue: 48000,
            accountWeightPct: 48,
            holdingWeightPct: 61.54,
            category: '核心仓',
          },
          {
            code: '600276',
            name: '恒瑞医药',
            concept: '创新药',
            qty: 6,
            sellableQty: 6,
            price: 50,
            marketValue: 30000,
            accountWeightPct: 30,
            holdingWeightPct: 38.46,
            category: '标准仓',
          },
        ],
      },
      modelOutput: {
        executionSummary: {
          verdict: 'rebalance',
          todayGoal: '降低PCB并补充机器人',
          nextReviewTrigger: '成交后重新核验',
        },
        allocation: {
          targetPositionPct: 66,
          categoryTargets: {
            corePct: 30,
            standardPct: 30,
            satellitePct: 6,
          },
        },
        stockActions: [{
          priority: 1,
          code: '300476',
          action: 'reduce',
          targetWeightPct: 30,
          triggerPrice: 90,
          invalidation: '放量突破前高',
          reason: '集中度48%且量化偏弱',
          evidenceIds: ['E1'],
        }],
        recommendations: [{
          priority: 2,
          concept: '机器人',
          code: '002747',
          targetWeightPct: 6,
          maxWeightPct: 6,
          triggerPrice: 30,
          trigger: '放量站稳30元',
          invalidation: '跌破28元',
          reason: '概念资金和量化共振',
          evidenceIds: ['E2'],
        }],
        conceptActions: [
          {
            concept: 'PCB',
            targetWeightPct: 30,
            reason: '降低集中度',
            evidenceIds: ['E1'],
          },
          {
            concept: '创新药',
            targetWeightPct: 30,
            reason: '维持配置',
            evidenceIds: ['E1'],
          },
          {
            concept: '机器人',
            targetWeightPct: 6,
            reason: '补充缺失方向',
            evidenceIds: ['E2'],
          },
        ],
        scenarioPlan: [
          {
            regime: 'strong',
            signal: '指数放量',
            targetPositionPct: 76,
            actions: ['确认后增加仓位'],
          },
          {
            regime: 'weak',
            signal: '指数跌破支撑',
            targetPositionPct: 50,
            actions: ['继续降低集中仓'],
          },
        ],
      },
      allowedEvidenceIds: ['E1', 'E2'],
      allowedHoldingCodes: ['300476', '600276'],
      allowedRecommendationCodes: ['002747'],
      recommendationCatalog: {
        '002747': {
          code: '002747',
          name: '埃斯顿',
          concept: '机器人',
          price: 30,
        },
      },
    },
    expect: {
      minOverall: 0.9,
      requiredOrderCodes: ['300476', '002747'],
      forbiddenOrderCodes: ['000000'],
      maxT1Violations: 0,
    },
  }
}

test('Harness manifest与case在执行前完成边界校验', () => {
  assert.deepEqual(
    validateHarnessManifest(manifest).schemaVersion,
    'harness-manifest.v1',
  )
  assert.equal(validateHarnessCase(passingCase()).id, 'portfolio-pass')
  assert.throws(
    () => validateHarnessCase({
      ...passingCase(),
      input: {
        ...passingCase().input,
        apiKey: 'sk-secret',
      },
    }),
    /敏感字段/,
  )
  assert.throws(
    () => validateHarnessCase({
      ...passingCase(),
      expect: {
        ...passingCase().expect,
        accessToken: 'opaque-production-token',
      },
    }),
    /敏感字段/,
  )
  assert.throws(
    () => validateHarnessCase({
      ...passingCase(),
      tags: ['portfolio', 'sk-secret-in-tag'],
    }),
    /疑似密钥/,
  )
})

test('硬门禁失败时总分达标也必须失败', () => {
  const scored = scoreHarnessChecks([
    {
      id: 'schema',
      dimension: 'contract',
      passed: true,
    },
    {
      id: 'grounding',
      dimension: 'groundedness',
      passed: false,
      hard: true,
      message: '出现白名单外股票',
    },
    {
      id: 'feasible',
      dimension: 'feasibility',
      passed: true,
    },
    {
      id: 'actionable',
      dimension: 'actionability',
      passed: true,
    },
    {
      id: 'consistent',
      dimension: 'consistency',
      passed: true,
    },
  ], {
    weights,
    minOverall: 0.7,
  })

  assert.equal(scored.overall >= 0.7, true)
  assert.equal(scored.passed, false)
  assert.equal(scored.hardFailures.length, 1)
})

test('持仓套件生成可审计episode并使用生产标准化逻辑', async () => {
  const first = await runHarnessSuite({
    manifest,
    suiteId: 'portfolio',
    cases: [passingCase()],
    adapters: {
      portfolio: runPortfolioHarnessCase,
    },
    now: () => 1000,
  })
  const second = await runHarnessSuite({
    manifest,
    suiteId: 'portfolio',
    cases: [structuredClone(passingCase())],
    adapters: {
      portfolio: runPortfolioHarnessCase,
    },
    now: () => 2000,
  })

  assert.equal(first.ok, true)
  assert.equal(first.episodes.length, 1)
  assert.equal(first.episodes[0].status, 'PASS')
  assert.equal(first.episodes[0].scores.overall, 1)
  assert.match(first.episodes[0].inputFingerprint, /^input\./)
  assert.equal(
    first.episodes[0].inputFingerprint,
    second.episodes[0].inputFingerprint,
  )
  assert.deepEqual(
    first.episodes[0].output.executionPlan.orders.map(
      (order) => [order.code, order.estimatedLots],
    ),
    [
      ['300476', 2],
      ['002747', 1],
    ],
  )
})

test('失败case返回FAIL并给出可定位失败归因', async () => {
  const invalid = passingCase()
  invalid.id = 'portfolio-fabricated-code'
  invalid.input.modelOutput.recommendations[0].code = '000000'
  invalid.expect.requiredOrderCodes = ['000000']
  const run = await runHarnessSuite({
    manifest,
    suiteId: 'portfolio',
    cases: [invalid],
    adapters: {
      portfolio: runPortfolioHarnessCase,
    },
  })

  assert.equal(run.ok, false)
  assert.equal(run.episodes[0].status, 'FAIL')
  assert.ok(run.episodes[0].failures.some((failure) =>
    failure.code === 'EXPECTED_ORDER_MISSING'
  ))
})

test('Markdown报告可扫读且敏感字段统一脱敏', async () => {
  const run = await runHarnessSuite({
    manifest,
    suiteId: 'portfolio',
    cases: [passingCase()],
    adapters: {
      portfolio: runPortfolioHarnessCase,
    },
  })
  const markdown = renderHarnessMarkdown(run)
  const sanitized = sanitizeHarnessValue({
    apiKey: 'sk-sensitive',
    nested: { password: 'secret', model: 'gpt-5.6-terra' },
  })

  assert.match(markdown, /Harness Report/)
  assert.match(markdown, /portfolio-pass/)
  assert.equal(markdown.includes('sk-sensitive'), false)
  assert.deepEqual(sanitized, {
    apiKey: '[REDACTED]',
    nested: {
      password: '[REDACTED]',
      model: 'gpt-5.6-terra',
    },
  })
})

test('真实manifest与case可通过统一CLI离线执行', async () => {
  const result = await runHarnessCli([
    '--format',
    'json',
    '--no-write',
  ])
  const payload = JSON.parse(result.output)

  assert.equal(result.exitCode, 0)
  assert.equal(payload.ok, true)
  assert.equal(payload.summary.total, 52)
  assert.equal(payload.summary.passed, 52)
  assert.deepEqual(
    [...new Set(payload.episodes.map((item) => item.adapter))].sort(),
    [
      'advice',
      'daily',
      'decision-lifecycle',
      'evidence',
      'execution',
      'judge',
      'portfolio',
      'screen',
      'sector',
    ],
  )
})

test('Harness接入npm命令、CI门禁与报告artifact', () => {
  assert.match(packageJson.scripts.harness, /harness\/run\.mjs/)
  assert.match(packageJson.scripts['harness:ci'], /harness\/run\.mjs/)
  assert.match(packageJson.scripts['harness:execution'], /--suite execution/)
  assert.match(
    packageJson.scripts['harness:lifecycle'],
    /--suite decision-lifecycle/,
  )
  assert.match(
    packageJson.scripts['evaluate:lifecycle'],
    /run-decision-lifecycle-evaluation\.mjs/,
  )
  assert.match(packageJson.scripts['test:ci'], /--test-concurrency=1/)
  assert.match(workflow, /npm run harness:ci/)
  assert.match(workflow, /npm run test:ci/)
  assert.match(workflow, /npm run build/)
  assert.match(workflow, /actions\/upload-artifact@v7/)
  assert.match(gitignore, /harness-artifacts\//)
})

test('FC最小运行包保留Harness离线与显式在线命令', () => {
  assert.match(buildFcPackage, /package-lock\.json/)
  assert.match(buildFcPackage, /'ci'/)
  assert.match(buildFcPackage, /'--omit=dev'/)
  assert.match(
    buildFcPackage,
    /'--registry=https:\/\/registry\.npmjs\.org\/'/,
  )
  assert.match(buildFcPackage, /'--fetch-retries=5'/)
  assert.doesNotMatch(fcRuntimeLock, /bnpm\.byted\.org/)
  assert.match(fcRuntimeLock, /registry\.npmjs\.org/)
  assert.match(fcRuntimePackage.scripts.harness, /harness\/run\.mjs/)
  assert.match(fcRuntimePackage.scripts['harness:online'], /--online/)
  assert.match(fcRuntimePackage.scripts['harness:shadow'], /--online/)
})

test('在线军师Harness显式鉴权且不把密码写入结果', () => {
  assert.match(onlineAdviceHarness, /HARNESS_PASSWORD/)
  assert.match(onlineAdviceHarness, /x-account-password/)
  assert.doesNotMatch(
    onlineAdviceHarness,
    /summary\s*=\s*\{[\s\S]*password/s,
  )
})

test('生产失败可脱敏导出为立即可回放的Harness case', () => {
  const exported = createRegressionCase({
    caseId: 'judge-production-low-confidence',
    adapter: 'judge',
    tags: ['production-failure', 'judge'],
    input: {
      side: 'buy',
      deterministic: {
        decision: 'confirm',
        score: 3,
      },
      llm: {
        decision: 'confirm',
        confidence: 70,
        reasoning: '隐藏推理不得保存',
      },
      observationAgeMs: 180000,
      apiKey: 'sk-sensitive-value',
      account: {
        nick: 'private-user',
        password: 'private-password',
      },
      transport: {
        authorizationHeader: 'Bearer private-credential',
        llmApiKey: 'opaque-private-key',
        userNickname: 'private-user',
      },
    },
    expect: {
      minOverall: 0.9,
      decision: 'wait',
      policy: 'confidence-gated',
      reasonIncludes: ['把握不足'],
    },
  })
  const serialized = serializeRegressionCaseSet([exported])

  assert.equal(exported.schemaVersion, 'harness-case.v1')
  assert.equal(exported.id, 'judge-production-low-confidence')
  assert.equal(exported.input.llm.reasoning, undefined)
  assert.equal(exported.input.apiKey, undefined)
  assert.equal(exported.input.account.nick, undefined)
  assert.equal(
    exported.input.transport.authorizationHeader,
    undefined,
  )
  assert.equal(exported.input.transport.llmApiKey, undefined)
  assert.equal(exported.input.transport.userNickname, undefined)
  assert.equal(serialized.includes('sk-sensitive-value'), false)
  assert.doesNotThrow(() => JSON.parse(serialized))
})

test('export CLI导出的生产失败可通过case-file立即回放', async () => {
  const caseId = `judge-production-replay-${process.pid}`
  const inputDir = await mkdtemp(
    path.join(tmpdir(), 'stock-harness-export-'),
  )
  const inputPath = path.join(inputDir, 'failure.json')
  const replayPath = `cases/regressions/${caseId}.json`
  const replayFile = new URL(
    `../harness/${replayPath}`,
    import.meta.url,
  )
  await writeFile(inputPath, JSON.stringify({
    caseId,
    adapter: 'judge',
    tags: ['production-failure', 'judge'],
    input: {
      side: 'buy',
      deterministic: {
        decision: 'confirm',
        score: 3,
      },
      llm: {
        decision: 'confirm',
        confidence: 70,
        reason: '方向偏多但把握不足',
      },
      observationAgeMs: 180000,
      apiKey: 'sk-sensitive-value',
      account: {
        nick: 'private-user',
        password: 'private-password',
      },
    },
    expect: {
      minOverall: 0.9,
      decision: 'wait',
      policy: 'confidence-gated',
      reasonIncludes: ['把握不足'],
    },
  }))

  try {
    const exported = await exportHarnessFailure([
      '--input',
      inputPath,
    ])
    const replayed = await runHarnessCli([
      '--suite',
      'judge',
      '--case-file',
      replayPath,
      '--format',
      'json',
      '--no-write',
      '--no-baseline',
    ])
    const payload = JSON.parse(replayed.output)

    assert.equal(exported.exitCode, 0)
    assert.equal(exported.output.includes(caseId), true)
    assert.equal(replayed.exitCode, 0)
    assert.equal(payload.summary.total, 1)
    assert.equal(payload.episodes[0].caseId, caseId)
    assert.equal(payload.episodes[0].status, 'PASS')
    assert.equal(
      JSON.stringify(payload).includes('sk-sensitive-value'),
      false,
    )
  } finally {
    await rm(inputDir, { recursive: true, force: true })
    await rm(replayFile, { force: true })
  }
})

test('Harness基线阻止低于允许回撤的静默质量退化', () => {
  const baseline = {
    schemaVersion: 'harness-baseline.v1',
    suites: {
      portfolio: {
        overall: 1,
        dimensions: {
          contract: 1,
          groundedness: 1,
          feasibility: 1,
          actionability: 1,
          consistency: 1,
        },
      },
    },
  }
  const compared = compareHarnessBaseline([{
    suiteId: 'portfolio',
    summary: {
      overall: 0.9,
      dimensions: {
        contract: 1,
        groundedness: 1,
        feasibility: 0.8,
        actionability: 0.8,
        consistency: 1,
      },
    },
  }], baseline, {
    overall: 0.05,
    dimension: 0.05,
  })

  assert.equal(compared.passed, false)
  assert.ok(compared.regressions.some((item) =>
    item.metric === 'overall'
  ))
  assert.ok(compared.regressions.some((item) =>
    item.metric === 'feasibility'
  ))
})

test('单suite运行只比较本次执行范围', () => {
  const perfect = {
    overall: 1,
    dimensions: {
      contract: 1,
      groundedness: 1,
      feasibility: 1,
      actionability: 1,
      consistency: 1,
    },
    cases: 1,
    caseIds: ['sector-case'],
  }
  const baseline = {
    schemaVersion: 'harness-baseline.v1',
    suites: {
      sector: perfect,
      portfolio: {
        ...perfect,
        caseIds: ['portfolio-case'],
      },
    },
  }
  const compared = compareHarnessBaseline([{
    suiteId: 'sector',
    summary: {
      total: 1,
      overall: 1,
      dimensions: perfect.dimensions,
    },
    episodes: [{ caseId: 'sector-case' }],
  }], baseline)

  assert.equal(compared.passed, true)
  assert.deepEqual(compared.regressions, [])
})

test('全量基线比较仍拒绝未执行的suite', () => {
  const baseline = {
    schemaVersion: 'harness-baseline.v1',
    suites: {
      sector: {
        overall: 1,
        dimensions: {},
      },
      portfolio: {
        overall: 1,
        dimensions: {},
      },
    },
  }
  const compared = compareHarnessBaseline([{
    suiteId: 'sector',
    summary: {
      overall: 1,
      dimensions: {},
    },
  }], baseline, {
    requireAllSuites: true,
  })

  assert.equal(compared.passed, false)
  assert.ok(compared.regressions.some((item) =>
    item.suiteId === 'portfolio' && item.metric === 'suite'
  ))
})

test('Harness基线拒绝通过删除困难case维持高分', () => {
  const baseline = {
    schemaVersion: 'harness-baseline.v1',
    suites: {
      judge: {
        overall: 1,
        dimensions: {
          contract: 1,
          groundedness: 1,
          feasibility: 1,
          actionability: 1,
          consistency: 1,
        },
        cases: 2,
        caseIds: ['judge-easy', 'judge-hard'],
      },
    },
  }
  const compared = compareHarnessBaseline([{
    suiteId: 'judge',
    summary: {
      total: 1,
      overall: 1,
      dimensions: {
        contract: 1,
        groundedness: 1,
        feasibility: 1,
        actionability: 1,
        consistency: 1,
      },
    },
    episodes: [{ caseId: 'judge-easy' }],
  }], baseline)

  assert.equal(compared.passed, false)
  assert.ok(compared.regressions.some((item) => item.metric === 'cases'))
  assert.ok(compared.regressions.some((item) =>
    item.metric === 'caseIds'
    && item.message.includes('judge-hard')
  ))
})

test('当前运行可生成带版本归因的稳定基线', () => {
  const baseline = createHarnessBaseline([{
    suiteId: 'judge',
    summary: {
      overall: 1,
      dimensions: {
        contract: 1,
        groundedness: 1,
        feasibility: 1,
        actionability: 1,
        consistency: 1,
      },
    },
  }], {
    generatedAt: 1000,
    versions: {
      app: '1.0.0',
      git: 'abc123',
      node: '20',
    },
  })

  assert.equal(baseline.schemaVersion, 'harness-baseline.v1')
  assert.equal(baseline.suites.judge.overall, 1)
  assert.deepEqual(baseline.versions, {
    app: '1.0.0',
    git: 'abc123',
    node: '20',
  })
})

test('基线更新拒绝单suite、在线suite与临时case', async () => {
  const baselinePath = `baselines/test-${process.pid}.json`
  const baselineFile = new URL(
    `../harness/${baselinePath}`,
    import.meta.url,
  )

  try {
    await assert.rejects(
      runHarnessCli([
        '--suite',
        'portfolio',
        '--update-baseline',
        '--baseline',
        baselinePath,
        '--no-write',
      ]),
      /全部离线suite/,
    )
    await assert.rejects(
      runHarnessCli([
        '--suite',
        'judge',
        '--case-file',
        'cases/judge.json',
        '--update-baseline',
        '--baseline',
        baselinePath,
        '--no-write',
      ]),
      /全部离线suite/,
    )
  } finally {
    await rm(baselineFile, { force: true })
  }
})

test('端点Harness逐个验证模型、对话、Function Calling与流式输出', async () => {
  const config = {
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://advisor-1.example/v1',
        apiKey: 'advisor-1-key',
        model: 'gpt-5.6-terra',
        reasoning: true,
        enabled: true,
      }, {
        baseUrl: 'https://advisor-2.example/v1',
        apiKey: 'advisor-2-key',
        model: 'gpt-5.6-terra',
        reasoning: true,
        enabled: true,
      }],
    },
  }
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/models')) {
      return Response.json({
        data: [{ id: 'gpt-5.6-terra' }],
      })
    }
    const body = JSON.parse(init.body || '{}')
    if (body.stream) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200 },
      )
    }
    if (body.tools) {
      return Response.json({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'get_portfolio_snapshot',
                arguments: '{}',
              },
            }],
          },
        }],
        usage: { total_tokens: 20 },
      })
    }
    return Response.json({
      choices: [{ message: { content: 'OK' } }],
      usage: { total_tokens: 10 },
    })
  }
  const result = await runEndpointHarnessCase({
    input: {
      role: 'advisor',
      capabilities: ['models', 'chat', 'function', 'stream'],
      timeoutMs: 1000,
    },
    expect: {
      minEndpoints: 2,
      maxLatencyMs: 1000,
      maxTotalTokens: 100,
    },
  }, {
    config,
    fetchImpl,
  })
  const scored = scoreHarnessChecks(result.checks, {
    weights,
    minOverall: 0.9,
  })

  assert.equal(scored.passed, true)
  assert.equal(result.output.endpoints.length, 2)
  assert.equal(result.output.endpoints.every((item) =>
    item.capabilities.function.ok
    && item.capabilities.stream.ok
  ), true)
  assert.equal(JSON.stringify(result.output).includes('advisor-1-key'), false)
  assert.equal(JSON.stringify(result.output).includes('advisor-2-key'), false)
})

test('端点Harness按完整响应体统计延迟预算', async () => {
  const delayedPayload = JSON.stringify({
    choices: [{ message: { content: 'OK' } }],
    usage: { total_tokens: 10 },
  })
  const fetchImpl = async () => new Response(
    new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(delayedPayload),
          )
          controller.close()
        }, 30)
      },
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
  const result = await runEndpointHarnessCase({
    input: {
      role: 'portfolio',
      capabilities: ['chat'],
      timeoutMs: 1000,
    },
    expect: {
      minEndpoints: 1,
      maxLatencyMs: 10,
      maxTotalTokens: 100,
    },
  }, {
    config: {
      baseUrl: 'https://main.example/v1',
      apiKey: 'main-key',
      models: { portfolio: 'gpt-5.6-terra' },
    },
    fetchImpl,
  })
  const scored = scoreHarnessChecks(result.checks, {
    weights,
    minOverall: 0.9,
  })

  assert.equal(scored.passed, false)
  assert.ok(scored.failures.some((failure) =>
    failure.code === 'ENDPOINT_LATENCY_BUDGET_EXCEEDED'
  ))
  assert.ok(result.metrics.maxLatencyMs >= 25)
})

test('在线Harness错误输出按端点实际Key精确脱敏', async () => {
  const apiKey = 'opaque-production-credential'
  const fetchImpl = async () => Response.json({
    error: {
      message: `Credential ${apiKey} rejected`,
    },
  }, { status: 401 })
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey,
    models: { portfolio: 'gpt-5.6-terra' },
  }
  const endpoint = await runEndpointHarnessCase({
    input: {
      role: 'portfolio',
      capabilities: ['chat'],
      timeoutMs: 1000,
    },
    expect: {
      minEndpoints: 1,
      maxLatencyMs: 1000,
      maxTotalTokens: 100,
    },
  }, {
    config,
    fetchImpl,
  })
  const shadow = await runShadowHarnessCase({
    input: {
      role: 'portfolio',
      prompt: '只输出JSON。',
      allowedCodes: ['600000'],
      allowedEvidenceIds: ['E1'],
      timeoutMs: 1000,
    },
    expect: {
      minResponses: 1,
      minAgreement: 1,
      maxLatencyMs: 1000,
      maxTotalTokens: 100,
    },
  }, {
    config,
    fetchImpl,
  })

  assert.equal(JSON.stringify(endpoint.output).includes(apiKey), false)
  assert.equal(JSON.stringify(shadow.output).includes(apiKey), false)
})

test('影子Harness对拍多端点结构化结论且不影响生产', async () => {
  const config = {
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://advisor-1.example/v1',
        apiKey: 'advisor-1-key',
        model: 'gpt-5.6-terra',
        enabled: true,
      }, {
        baseUrl: 'https://advisor-2.example/v1',
        apiKey: 'advisor-2-key',
        model: 'gpt-5.6-terra',
        enabled: true,
      }],
    },
  }
  const fetchImpl = async () => Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          decision: 'wait',
          code: '600000',
          targetWeightPct: 0,
          reason: '证据不足',
          trigger: '量价共振后重评',
          evidenceIds: ['E1'],
        }),
      },
    }],
    usage: { total_tokens: 30 },
  })
  const result = await runShadowHarnessCase({
    input: {
      role: 'advisor',
      prompt: '根据E1评估600000，只输出JSON。',
      allowedCodes: ['600000'],
      allowedEvidenceIds: ['E1'],
      timeoutMs: 1000,
    },
    expect: {
      minResponses: 2,
      minAgreement: 1,
      maxLatencyMs: 1000,
      maxTotalTokens: 100,
    },
  }, {
    config,
    fetchImpl,
  })
  const scored = scoreHarnessChecks(result.checks, {
    weights,
    minOverall: 0.9,
  })

  assert.equal(scored.passed, true)
  assert.equal(result.output.shadowOnly, true)
  assert.equal(result.output.actionable, false)
  assert.equal(result.output.agreement, 1)
  assert.equal(JSON.stringify(result.output).includes('advisor-1-key'), false)
  assert.equal(JSON.stringify(result.output).includes('advisor-2-key'), false)
})

test('影子Harness必须显式拦截模型尝试引用的未知证据', async () => {
  const result = await runShadowHarnessCase({
    input: {
      role: 'portfolio',
      prompt: '根据E1评估600000，只输出JSON。',
      allowedCodes: ['600000'],
      allowedEvidenceIds: ['E1'],
      timeoutMs: 1000,
    },
    expect: {
      minResponses: 1,
      minAgreement: 1,
      maxLatencyMs: 1000,
      maxTotalTokens: 100,
    },
  }, {
    config: {
      baseUrl: 'https://main.example/v1',
      apiKey: 'main-key',
      models: { portfolio: 'gpt-5.6-terra' },
    },
    fetchImpl: async () => Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: 'wait',
            code: '600000',
            targetWeightPct: 0,
            reason: '证据不足',
            trigger: '补齐证据后重评',
            evidenceIds: ['E1', 'FABRICATED'],
          }),
        },
      }],
      usage: { total_tokens: 30 },
    }),
  })
  const scored = scoreHarnessChecks(result.checks, {
    weights,
    minOverall: 0.9,
  })

  assert.equal(scored.passed, false)
  assert.ok(scored.hardFailures.some((failure) =>
    failure.code === 'SHADOW_EVIDENCE_NOT_ALLOWED'
  ))
})
