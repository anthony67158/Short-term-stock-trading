import { getStrategyCatalogV2 } from './strategyCatalogV2.js'
import { CURRENT_STRATEGY_EVALUATION } from './strategyPromotionGate.js'

export const STRATEGY_LIFECYCLE_STATES = Object.freeze([
  'draft',
  'backtested',
  'rejected',
  'shadow',
  'paper-qualified',
  'approved',
  'active',
  'suspended',
  'retired',
])

const TRANSITIONS = Object.freeze({
  draft: new Set(['backtested', 'retired']),
  backtested: new Set(['rejected', 'shadow', 'retired']),
  rejected: new Set(['draft', 'retired']),
  shadow: new Set(['rejected', 'paper-qualified', 'suspended', 'retired']),
  'paper-qualified': new Set([
    'approved',
    'rejected',
    'suspended',
    'retired',
  ]),
  approved: new Set(['active', 'suspended', 'retired']),
  active: new Set(['suspended', 'retired']),
  suspended: new Set(['shadow', 'approved', 'active', 'retired']),
  retired: new Set(),
})

function safeMetrics(evaluation = {}) {
  const benchmarks = evaluation.benchmarks || {}
  return {
    folds: Math.max(0, Number(evaluation.folds) || 0),
    positiveFolds: Math.max(0, Number(evaluation.positiveFolds) || 0),
    compoundedReturn: Number(evaluation.compoundedReturn) || 0,
    maximumDrawdown: Number(evaluation.maximumDrawdown) || 0,
    benchmarks: {
      CSI300: {
        positiveExcessFolds:
          Number(benchmarks.CSI300?.positiveExcessFolds) || 0,
        compoundedExcessReturn:
          Number(benchmarks.CSI300?.compoundedExcessReturn) || 0,
      },
      CSI1000: {
        positiveExcessFolds:
          Number(benchmarks.CSI1000?.positiveExcessFolds) || 0,
        compoundedExcessReturn:
          Number(benchmarks.CSI1000?.compoundedExcessReturn) || 0,
      },
    },
  }
}

function defaultRecord(strategy) {
  const isBaseline = strategy.strategyId === 'market-quant-resonance'
  const legacyEvaluation = isBaseline ? CURRENT_STRATEGY_EVALUATION : null
  return {
    strategyId: strategy.strategyId,
    specVersion: strategy.specVersion,
    family: strategy.family,
    state: isBaseline ? 'rejected' : 'draft',
    updatedAt: isBaseline
      ? Date.parse(`${CURRENT_STRATEGY_EVALUATION.evaluatedAt}T00:00:00Z`)
      : 0,
    artifactHash: null,
    evaluationVersion: legacyEvaluation?.specVersion || null,
    evaluation: legacyEvaluation
      ? {
          schemaVersion: legacyEvaluation.schemaVersion,
          decision: legacyEvaluation.decision,
          evaluatedAt: legacyEvaluation.evaluatedAt,
          source: legacyEvaluation.source,
          ...safeMetrics(legacyEvaluation),
        }
      : null,
    shadow: {
      samples: 0,
      netReturn: null,
      maximumDrawdown: null,
      profitFactor: null,
    },
    paper: {
      samples: 0,
      posteriorWinRate: null,
      profitFactor: null,
      expectancy: null,
    },
    blockers: isBaseline
      ? [
          {
            code: 'OFFLINE_REJECTED',
            message: '现有嵌套Walk-forward结论为REJECT',
          },
          {
            code: 'SPEC_VERSION_NOT_EVALUATED',
            message: 'StrategySpec v2 尚未在封存样本上完成复核',
          },
        ]
      : [{
          code: 'BACKTEST_REQUIRED',
          message: '尚未完成独立回测与封存样本验证',
        }],
    approval: null,
  }
}

function normalizeRecord(record, strategy) {
  const fallback = defaultRecord(strategy)
  if (!record || record.specVersion !== strategy.specVersion) return fallback
  const state = STRATEGY_LIFECYCLE_STATES.includes(record.state)
    ? record.state
    : fallback.state
  return {
    ...fallback,
    ...structuredClone(record),
    strategyId: strategy.strategyId,
    specVersion: strategy.specVersion,
    family: strategy.family,
    state,
    shadow: { ...fallback.shadow, ...(record.shadow || {}) },
    paper: { ...fallback.paper, ...(record.paper || {}) },
    blockers: Array.isArray(record.blockers)
      ? record.blockers.slice(0, 24)
      : fallback.blockers,
  }
}

export function buildDefaultStrategyGovernance(saved = {}) {
  const catalog = getStrategyCatalogV2()
  const records = saved?.strategies || saved || {}
  return {
    schemaVersion: 'strategy-governance.v2',
    catalogVersion: catalog.catalogVersion,
    strategies: catalog.strategies.map((strategy) =>
      normalizeRecord(
        Array.isArray(records)
          ? records.find(
              (record) => record?.strategyId === strategy.strategyId,
            )
          : records[strategy.strategyId],
        strategy,
      )
    ),
  }
}

export function transitionStrategyState(record, nextState, metadata = {}) {
  if (!record || !STRATEGY_LIFECYCLE_STATES.includes(record.state)) {
    throw new Error('当前策略治理状态无效')
  }
  if (!STRATEGY_LIFECYCLE_STATES.includes(nextState)) {
    throw new Error(`目标策略治理状态无效: ${nextState}`)
  }
  if (!TRANSITIONS[record.state].has(nextState)) {
    throw new Error(`不允许从${record.state}直接迁移到${nextState}`)
  }
  if (
    nextState === 'backtested'
    && !String(metadata.artifactHash || record.artifactHash || '').trim()
  ) {
    throw new Error('进入backtested必须绑定不可变回测产物哈希')
  }
  if (nextState === 'approved') {
    const approval = metadata.approval
    if (
      !approval
      || approval.specVersion !== record.specVersion
      || !String(approval.approvedBy || '').trim()
      || !(Number(approval.approvedAt) > 0)
    ) {
      throw new Error('进入approved必须绑定同版本人工批准')
    }
  }
  return {
    ...structuredClone(record),
    ...structuredClone(metadata),
    state: nextState,
    updatedAt: Number(metadata.updatedAt) || Date.now(),
    blockers: ['approved', 'active'].includes(nextState)
      ? []
      : structuredClone(metadata.blockers ?? record.blockers ?? []),
  }
}

export function strategyCanInfluenceProduction(record) {
  return record?.state === 'active'
    && record?.approval?.specVersion === record?.specVersion
    && !(record?.blockers || []).length
}
