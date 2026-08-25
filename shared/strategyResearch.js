import {
  humanizeUserFacingText,
  marketRegimeLabel,
  strategyStateLabel,
} from './userFacingLanguage.js'

const FAMILY_LABELS = Object.freeze({
  TREND_BREAKOUT: '趋势突破',
  CROSS_SECTIONAL_MOMENTUM: '截面动量',
  RANGE_MEAN_REVERSION: '震荡回归',
  MULTI_FACTOR_RANKING: '多因子排名',
  DEFENSIVE_EXIT: '防守退出',
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

function modelLabel(spec) {
  const dependencies = Array.isArray(spec?.modelDependencies)
    ? spec.modelDependencies
    : []
  return dependencies.length
    ? `${dependencies.length}个量化模型参与判断`
    : '无需额外量化模型'
}

function timeframeLabel(value) {
  return {
    '1d': '日线',
    '5m': '5分钟',
    NEXT_OPEN: '次日开盘',
    NEXT_BAR_OPEN: '下一时段开盘',
  }[String(value || '')] || humanizeUserFacingText(value || '待确认')
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
      stateLabel: strategyStateLabel(state),
      stateTone: state === 'active'
        ? 'active'
        : state === 'rejected' || state === 'suspended'
          ? 'blocked'
          : state === 'shadow' || state === 'paper-qualified'
            ? 'shadow'
            : 'draft',
      productionEligible: record.productionEligible === true,
      eligibleRegimes: (spec.eligibleRegimes || []).map(
        marketRegimeLabel,
      ),
      signalTimeframe: timeframeLabel(spec.signalTimeframe),
      executionTimeframe: timeframeLabel(spec.executionTimeframe),
      horizon: `${spec.horizon?.value || '—'}${
        spec.horizon?.unit === 'MINUTE' ? '分钟' : '交易日'
      }`,
      modelVersion: modelVersion(spec),
      modelLabel: modelLabel(spec),
      versionLabel: '规则版本已记录',
      dataVersion: String(
        record.datasetVersion
        || record.evaluation?.datasetVersion
        || '待生成v2数据集',
      ),
      backtest: backtestView(record.evaluation),
      shadow: {
        samples: Math.max(0, Number(record.shadow?.samples) || 0),
        pending: Math.max(0, Number(record.shadow?.pending) || 0),
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
            (item) => humanizeUserFacingText(
              item.message || '仍有上线条件未满足',
            ),
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
