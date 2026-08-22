const STATE_LABELS = Object.freeze({
  draft: '草稿',
  backtested: '已回测',
  rejected: '已拒绝',
  shadow: '影子运行',
  'paper-qualified': '模拟达标',
  approved: '已批准',
  active: '生产启用',
  suspended: '已暂停',
  retired: '已退役',
})

const FAMILY_LABELS = Object.freeze({
  TREND_BREAKOUT: '趋势突破',
  CROSS_SECTIONAL_MOMENTUM: '截面动量',
  RANGE_MEAN_REVERSION: '震荡回归',
  MULTI_FACTOR_RANKING: '多因子排名',
  DEFENSIVE_EXIT: '防守退出',
})

const REGIME_LABELS = Object.freeze({
  TREND_STRONG: '强趋势',
  RANGE: '震荡',
  TRANSITION: '切换',
  RISK_OFF: '防守',
  UNKNOWN: '未知',
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function percent(value) {
  const number = finite(value)
  return number == null ? null : +(number * 100).toFixed(2)
}

function backtestView(evaluation) {
  if (!evaluation) {
    return {
      available: false,
      folds: 0,
      positiveFolds: 0,
      returnPct: null,
      drawdownPct: null,
      csi300ExcessPct: null,
      csi1000ExcessPct: null,
      source: null,
    }
  }
  return {
    available: true,
    folds: Math.max(0, Number(evaluation.folds) || 0),
    positiveFolds: Math.max(
      0,
      Number(evaluation.positiveFolds) || 0,
    ),
    returnPct: percent(evaluation.compoundedReturn),
    drawdownPct: percent(evaluation.maximumDrawdown),
    csi300ExcessPct: percent(
      evaluation.benchmarks?.CSI300?.compoundedExcessReturn,
    ),
    csi1000ExcessPct: percent(
      evaluation.benchmarks?.CSI1000?.compoundedExcessReturn,
    ),
    source: String(evaluation.source || ''),
  }
}

function modelVersion(spec) {
  const dependencies = Array.isArray(spec?.modelDependencies)
    ? spec.modelDependencies
    : []
  if (!dependencies.length) return '无模型依赖'
  return dependencies.map((item) => {
    const dimensions = item.featureCount != null
      ? `/${item.featureCount}维`
      : ''
    return `${item.id}@${item.version}${dimensions}`
  }).join(' · ')
}

export function buildStrategyResearchView({
  catalog = {},
  governance = {},
} = {}) {
  const strategies = Array.isArray(catalog.data)
    ? catalog.data
    : Array.isArray(catalog.strategies) ? catalog.strategies : []
  const governanceRows = Array.isArray(governance.strategies)
    ? governance.strategies
    : []
  const rows = strategies.map((spec) => {
    const record = governanceRows.find(
      (item) => item.strategyId === spec.strategyId,
    ) || {}
    const blockers = Array.isArray(record.blockers) ? record.blockers : []
    const state = String(record.state || 'draft')
    return {
      strategyId: spec.strategyId,
      specVersion: spec.specVersion,
      name: spec.name,
      family: spec.family,
      familyLabel: FAMILY_LABELS[spec.family] || spec.family,
      purpose: spec.purpose,
      state,
      stateLabel: STATE_LABELS[state] || state,
      stateTone: state === 'active'
        ? 'active'
        : state === 'rejected' || state === 'suspended'
          ? 'blocked'
          : state === 'shadow' || state === 'paper-qualified'
            ? 'shadow'
            : 'draft',
      productionEligible: record.productionEligible === true,
      eligibleRegimes: (spec.eligibleRegimes || []).map(
        (item) => REGIME_LABELS[item] || item,
      ),
      signalTimeframe: spec.signalTimeframe,
      executionTimeframe: spec.executionTimeframe,
      horizon: `${spec.horizon?.value || '—'}${
        spec.horizon?.unit === 'MINUTE' ? '分钟' : '交易日'
      }`,
      modelVersion: modelVersion(spec),
      dataVersion: String(
        record.datasetVersion
        || record.evaluation?.datasetVersion
        || '待生成v2数据集',
      ),
      backtest: backtestView(record.evaluation),
      shadow: {
        samples: Math.max(0, Number(record.shadow?.samples) || 0),
        returnPct: percent(record.shadow?.netReturn),
        drawdownPct: percent(record.shadow?.maximumDrawdown),
        profitFactor: finite(record.shadow?.profitFactor),
      },
      real: {
        samples: Math.max(0, Number(record.paper?.samples) || 0),
        posteriorWinRate: finite(record.paper?.posteriorWinRate),
        profitFactor: finite(record.paper?.profitFactor),
        expectancy: finite(record.paper?.expectancy),
      },
      blockers,
      blockerText: blockers.length
        ? blockers.map(
            (item) => `${item.code || 'BLOCKED'}：${item.message || ''}`,
          ).join('；')
        : '',
    }
  })
  const count = (state) => rows.filter((item) => item.state === state).length
  return {
    schemaVersion: 'strategy-research-view.v1',
    catalogVersion: catalog.catalogVersion
      || governance.catalogVersion
      || null,
    summary: {
      total: rows.length,
      active: count('active'),
      shadow: count('shadow'),
      rejected: count('rejected'),
      draft: count('draft'),
    },
    rows,
  }
}
