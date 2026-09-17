const LEARNING_MODELS = Object.freeze({
  stockPick: {
    id: 'stock-pick-ranking',
    name: '选股排序模型',
    task: '全市场候选排序',
  },
  position: {
    id: 'position-decision',
    name: '持仓决策模型',
    task: '持仓动作价值回归',
  },
})

const LEGACY_MODELS = Object.freeze({
  opportunity: {
    id: 'opportunity-decision',
    name: '决策机会模型',
    task: '成交、盈利与动作价值',
  },
  stock: {
    id: 'legacy-stock',
    name: '个股模型',
    task: '个股概率与收益评估',
  },
  sector: {
    id: 'sector-forecast',
    name: '板块模型',
    task: '板块次日与周度预测',
  },
})

function text(value, maximum = 240) {
  const output = String(value ?? '').trim()
  return output ? output.slice(0, maximum) : null
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const output = Number(value)
  return Number.isFinite(output) ? output : null
}

function timestamp(value) {
  const output = new Date(value || 0).getTime()
  return Number.isFinite(output) && output > 0 ? output : null
}

function safeStrings(values, maximum = 80) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => text(value, maximum)).filter(Boolean))]
    : []
}

function learningState(status) {
  if (status === 'CHALLENGER_PASSED') return 'passed'
  if (status === 'CHALLENGER_REJECTED') return 'rejected'
  if (status === 'SKIPPED_INSUFFICIENT_MATURED_DATA') return 'skipped'
  return 'failed'
}

function legacyState(decision) {
  if (['promote', 'updated'].includes(decision)) return 'published'
  if (decision === 'shadow') return 'passed'
  if (['reject', 'hold'].includes(decision)) return 'rejected'
  if (decision === 'skip') return 'skipped'
  if (decision === 'cancelled') return 'cancelled'
  return 'failed'
}

function metricUnit(name) {
  if (/ReturnPct$/i.test(name)) return 'percent-points'
  if (/MaeR$/i.test(name)) return 'r'
  return 'number'
}

function metricLabel(name) {
  const labels = {
    samples: '成熟样本',
    dates: '独立交易日',
    baselineTop5ReturnPct: '生产基线 Top5 费后收益',
    challengerTop5ReturnPct: '挑战者 Top5 费后收益',
    minimumSeedTop5ReturnPct: '最弱种子 Top5 费后收益',
    baselineMaeR: '生产基线 MAE',
    challengerMaeR: '挑战者 MAE',
    maximumSeedMaeR: '最弱种子 MAE',
  }
  return labels[name] || name
}

function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return []
  return Object.entries(metrics).flatMap(([name, value]) => {
    const numeric = finite(value)
    return numeric == null ? [] : [{
      key: name,
      label: metricLabel(name),
      value: numeric,
      unit: metricUnit(name),
    }]
  })
}

function reportHash(pathname) {
  const match = String(pathname || '').match(
    /^learning\/v1\/training-runs\/[^/]+\/([^/]+)\/report\.json$/,
  )
  return match?.[1] || ''
}

export function normalizeLearningTrainingReport(
  report,
  { pathname = '', uploadedAt = null } = {},
) {
  if (report?.schemaVersion !== 'learning-training-run.v1') return []
  const runAt = timestamp(report.generatedAt) || timestamp(uploadedAt)
  const hash = reportHash(pathname)
  return Object.entries(LEARNING_MODELS).flatMap(([key, model]) => {
    const result = report[key]
    if (!result || typeof result !== 'object') return []
    const training = result.training || {}
    const data = training.data || {}
    const productionChanged = report.productionPointerChanged === true
    return [{
      id: `${pathname || hash || runAt}:${model.id}`,
      source: 'daily-learning',
      schemaVersion: report.schemaVersion,
      modelId: model.id,
      modelName: model.name,
      task: model.task,
      runId: hash || null,
      runAt,
      status: learningState(result.status),
      rawStatus: text(result.status),
      eligible: result.eligible === true,
      productionChanged,
      version: text(result.modelVersion) || (
        hash ? `challenger-${hash}` : null
      ),
      algorithm: text(training.algorithm),
      objective: text(training.objective),
      label: text(training.label),
      labelVersion: text(training.labelVersion),
      features: safeStrings(training.features, 120),
      data: {
        samples: finite(data.samples ?? result.metrics?.samples),
        dates: finite(data.dates ?? result.metrics?.dates),
        startDate: text(data.startDate, 10),
        endDate: text(data.endDate, 10),
        trainSamples: finite(data.trainSamples),
        testSamples: finite(data.testSamples),
        trainDates: finite(data.trainDates),
        testDates: finite(data.testDates),
      },
      gate: {
        minimumSamples: finite(training.gate?.minimumSamples),
        minimumDates: finite(training.gate?.minimumDates),
        allSeedsMustNotRegress:
          training.gate?.allSeedsMustNotRegress === true,
      },
      seeds: Array.isArray(report.seeds)
        ? report.seeds.map(finite).filter((value) => value != null)
        : [],
      seedMetrics: Array.isArray(result.seedMetrics)
        ? result.seedMetrics
          .filter((item) => item && typeof item === 'object')
          .map((item) => Object.fromEntries(
            Object.entries(item).flatMap(([name, value]) => {
              const numeric = finite(value)
              return numeric == null ? [] : [[name, numeric]]
            }),
          ))
        : [],
      metrics: normalizeMetrics(result.metrics),
      reasons: safeStrings(result.reasons, 240),
      facts: [],
      comparisonMetrics: [],
      components: [],
      thresholds: [],
      artifacts: safeStrings(result.artifacts, 120),
      reportPath: text(pathname, 500),
      sourceViewHash: text(report.sourceViewHash, 128),
    }]
  })
}

function factValue(report, label) {
  const row = report?.details?.facts?.find((item) => item?.label === label)
  return text(row?.value)
}

export function normalizeLegacyTrainingReport(report, pathname = '') {
  if (!report || typeof report !== 'object') return null
  const family = Object.hasOwn(LEGACY_MODELS, report.model)
    ? report.model
    : 'stock'
  const model = LEGACY_MODELS[family]
  const facts = Array.isArray(report.details?.facts)
    ? report.details.facts.slice(0, 30).map((item) => ({
        label: text(item?.label, 80),
        value: text(item?.value, 240),
      })).filter((item) => item.label && item.value)
    : []
  const metrics = Array.isArray(report.details?.metrics)
    ? report.details.metrics.slice(0, 40).map((item) => ({
        label: text(item?.label, 100),
        unit: text(item?.unit, 30) || 'number',
        champion: finite(item?.champion ?? item?.baseline),
        challenger: finite(item?.challenger),
        selected: finite(item?.selected),
      })).filter((item) => item.label)
    : []
  const components = Array.isArray(report.details?.components)
    ? report.details.components.slice(0, 20).map((item) => ({
        label: text(item?.label || item?.component, 100),
        status: text(item?.status, 40),
        notes: safeStrings([
          ...(Array.isArray(item?.improvements) ? item.improvements : []),
          ...(Array.isArray(item?.blockers) ? item.blockers : []),
        ], 240).slice(0, 6),
      })).filter((item) => item.label)
    : []
  const thresholds = Object.entries(
    report.details?.thresholds?.overall || {},
  ).flatMap(([key, value]) => {
    const numeric = finite(value)
    return numeric == null ? [] : [{
      key: text(key, 80),
      value: numeric,
    }]
  })
  const productionChanged = report.decision === 'promote'
    || report.decision === 'updated'
  return {
    id: pathname || `legacy:${family}:${report.at || ''}`,
    source: 'quant-report',
    schemaVersion: text(report.schemaVersion) || 'legacy',
    modelId: model.id,
    modelName: model.name,
    task: model.task,
    runId: text(report.meta?.runId),
    runAt: timestamp(report.meta?.trainingAt) || timestamp(report.at),
    status: legacyState(report.decision),
    rawStatus: text(report.decision),
    eligible: report.decision === 'promote' || report.decision === 'shadow',
    productionChanged,
    version: factValue(report, '候选版本'),
    algorithm: factValue(report, '模型组合'),
    objective: null,
    label: null,
    labelVersion: null,
    features: [],
    data: {
      samples: finite(report.meta?.nSamples),
      dates: null,
      startDate: null,
      endDate: factValue(report, '训练截止')
        || factValue(report, '数据截止'),
      trainSamples: finite(report.meta?.adaptN),
      testSamples: finite(report.meta?.blindN ?? report.meta?.holdoutN),
      trainDates: Array.isArray(report.meta?.adaptDates)
        ? report.meta.adaptDates.length
        : null,
      testDates: Array.isArray(report.meta?.blindDates)
        ? report.meta.blindDates.length
        : Array.isArray(report.meta?.holdoutDates)
          ? report.meta.holdoutDates.length
          : null,
    },
    gate: {
      minimumSamples: finite(report.meta?.requiredSamples),
      minimumDates: finite(report.meta?.requiredDates),
      allSeedsMustNotRegress: false,
    },
    seeds: [],
    seedMetrics: [],
    metrics: [],
    reasons: safeStrings(report.details?.blockers, 240),
    facts,
    comparisonMetrics: metrics,
    components,
    thresholds,
    artifacts: [],
    reportPath: text(pathname, 500),
    sourceViewHash: null,
  }
}

export function buildModelTrainingSummary(runs = [], active = null) {
  const models = new Map()
  for (const definition of [
    ...Object.values(LEARNING_MODELS),
    ...Object.values(LEGACY_MODELS),
  ]) {
    models.set(definition.id, {
      ...definition,
      runs: 0,
      passed: 0,
      published: 0,
      latest: null,
      activeVersion:
        definition.id === 'opportunity-decision'
          ? text(active?.modelVersion)
          : null,
    })
  }
  for (const run of runs) {
    if (!models.has(run.modelId)) {
      models.set(run.modelId, {
        id: run.modelId,
        name: run.modelName,
        task: run.task,
        runs: 0,
        passed: 0,
        published: 0,
        latest: null,
        activeVersion: null,
      })
    }
    const model = models.get(run.modelId)
    model.runs += 1
    if (run.status === 'passed' || run.status === 'published') model.passed += 1
    if (run.productionChanged) model.published += 1
    if (!model.latest || Number(run.runAt || 0) > Number(model.latest.runAt || 0)) {
      model.latest = {
        id: run.id,
        runAt: run.runAt,
        status: run.status,
        version: run.version,
      }
    }
  }
  return [...models.values()]
    .filter((model) => model.runs > 0 || model.activeVersion)
    .sort((left, right) =>
      Number(right.latest?.runAt || 0) - Number(left.latest?.runAt || 0)
    )
}
