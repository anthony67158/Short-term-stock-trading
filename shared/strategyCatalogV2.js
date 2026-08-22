import { compileStrategySpecV2 } from './strategySpecV2.js'

function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch
  }
  const output = { ...(base || {}) }
  for (const [key, value] of Object.entries(patch)) {
    output[key] = (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base?.[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    )
      ? merge(base[key], value)
      : value
  }
  return output
}

function common(overrides) {
  const value = merge({
    schemaVersion: 'strategy-spec.v2',
    strategyId: 'market-quant-resonance',
    name: '多因子排名',
    family: 'MULTI_FACTOR_RANKING',
    purpose: 'RANKING',
    horizon: { unit: 'TRADING_DAY', value: 5 },
    eligibleRegimes: ['TREND_STRONG', 'TRANSITION', 'RANGE'],
    signalTimeframe: '1d',
    executionTimeframe: 'NEXT_OPEN',
    data: {
      signalPrice: 'QFQ',
      executionPrice: 'RAW',
      pointInTime: true,
      completedBarsOnly: true,
      minimumHistoryBars: 60,
    },
    entry: {
      type: 'ALL',
      conditions: [
        { field: 'marketScore', op: 'GTE', value: 55 },
        { field: 'quant.score', op: 'GTE', value: 55 },
        { field: 'pct', op: 'BETWEEN', value: [-6, 8.8] },
        { field: 'volRatio', op: 'BETWEEN', value: [0.5, 8] },
      ],
    },
    exit: {
      stopLossPct: 3,
      takeProfitPct: 6,
      maxHoldingBars: 5,
      signal: null,
    },
    trailingStop: {
      enabled: true,
      activationPct: 4,
      atrMultiple: 2,
    },
    positionSizing: {
      method: 'RISK_BUDGET',
      riskPerTradePct: 0.6,
      allocationPct: 20,
      maxPositions: 5,
      lotSize: 100,
    },
    riskLimits: {
      maxPortfolioExposurePct: 70,
      maxStockWeightPct: 20,
      maxSectorExposurePct: 35,
      maxLossPct: 3,
      allowRiskIncrease: true,
    },
    liquidityLimits: {
      minimumAmount: 8e7,
      minimumAdv20: 1e8,
      maximumParticipationRate: 0.05,
      maximumSpreadBps: 20,
    },
    benchmark: ['CSI300', 'CSI1000'],
    capacityAssumptions: {
      capitalScenarios: [100000, 500000, 1000000, 5000000],
      slippageScenariosBps: [5, 10, 20],
      baseParticipationRate: 0.05,
    },
    modelDependencies: [{
      id: 'lgb-score-36',
      type: 'MODEL',
      version: 'production',
      featureCount: 36,
      required: true,
    }],
    execution: {
      feePolicy: 'A_SHARE_STANDARD_V1',
      tPlusOne: true,
      rejectLimitUpBuy: true,
      rejectLimitDownSell: true,
      carryUnfilledExit: true,
      baseSlippageBps: 5,
      spreadBps: 10,
    },
    score: {
      method: 'WEIGHTED_SUM',
      weights: {
        marketScore: 0.3,
        quantScore: 0.35,
        fund: 0.2,
        liquidity: 0.15,
      },
    },
  }, overrides)
  if (overrides?.score?.weights) {
    value.score.weights = structuredClone(overrides.score.weights)
  }
  delete value.specVersion
  return compileStrategySpecV2(value)
}

function strategyCatalog() {
  return [
    common({
      strategyId: 'trend-breakout',
      name: '趋势突破',
      family: 'TREND_BREAKOUT',
      purpose: 'ENTRY',
      eligibleRegimes: ['TREND_STRONG'],
      horizon: { unit: 'TRADING_DAY', value: 8 },
      entry: {
        type: 'ALL',
        conditions: [
          {
            field: 'technical.donchianBreakout',
            op: 'EQ',
            value: true,
          },
          { field: 'technical.maSlope20', op: 'GT', value: 0 },
          { field: 'volRatio', op: 'GTE', value: 1.2 },
          { field: 'quant.score', op: 'GTE', value: 60 },
        ],
      },
      exit: {
        stopLossPct: 3,
        takeProfitPct: 8,
        maxHoldingBars: 8,
        signal: {
          type: 'ANY',
          conditions: [
            { field: 'technical.maSlope20', op: 'LT', value: 0 },
            { field: 'technical.structureBreak', op: 'EQ', value: true },
          ],
        },
      },
      score: {
        method: 'WEIGHTED_SUM',
        weights: {
          trend: 0.35,
          quantScore: 0.3,
          volume: 0.2,
          liquidity: 0.15,
        },
      },
    }),
    common({
      strategyId: 'cross-sectional-momentum',
      name: '截面动量',
      family: 'CROSS_SECTIONAL_MOMENTUM',
      purpose: 'RANKING',
      eligibleRegimes: ['TREND_STRONG', 'TRANSITION'],
      entry: {
        type: 'ALL',
        conditions: [
          { field: 'relativeStrength20', op: 'GTE', value: 60 },
          { field: 'sector.breadth', op: 'GTE', value: 50 },
          { field: 'quant.score', op: 'GTE', value: 55 },
        ],
      },
      score: {
        method: 'WEIGHTED_SUM',
        weights: {
          relativeStrength: 0.35,
          sectorBreadth: 0.25,
          quantScore: 0.25,
          liquidity: 0.15,
        },
      },
    }),
    common({
      strategyId: 'range-mean-reversion',
      name: '震荡回归',
      family: 'RANGE_MEAN_REVERSION',
      purpose: 'POSITION_MANAGEMENT',
      horizon: { unit: 'MINUTE', value: 60 },
      eligibleRegimes: ['RANGE'],
      signalTimeframe: '5m',
      executionTimeframe: 'NEXT_BAR_OPEN',
      data: {
        minimumHistoryBars: 48,
      },
      entry: {
        type: 'ALL',
        conditions: [
          { field: 'account.hasBasePosition', op: 'EQ', value: true },
          {
            field: 'technical.bollPct',
            op: 'BETWEEN',
            value: [0.05, 0.35],
          },
          {
            field: 'technical.rsi6',
            op: 'BETWEEN',
            value: [20, 45],
          },
          {
            field: 'technical.vwapDeviationPct',
            op: 'BETWEEN',
            value: [-3, 0],
          },
          {
            field: 'technical.atrPct',
            op: 'BETWEEN',
            value: [1, 5],
          },
        ],
      },
      exit: {
        stopLossPct: 2,
        takeProfitPct: 3,
        maxHoldingBars: 12,
        signal: null,
      },
      trailingStop: {
        enabled: false,
        activationPct: 2,
        atrMultiple: 1.5,
      },
      positionSizing: {
        allocationPct: 10,
        maxPositions: 5,
      },
      riskLimits: {
        maxPortfolioExposurePct: 60,
        maxStockWeightPct: 20,
        maxSectorExposurePct: 30,
        maxLossPct: 2,
        allowRiskIncrease: true,
      },
      modelDependencies: [{
        id: 'intraday-indicators-v1',
        type: 'FACTOR_SET',
        version: '1',
        required: true,
      }],
      score: {
        method: 'WEIGHTED_SUM',
        weights: {
          meanReversion: 0.4,
          vwap: 0.25,
          volatility: 0.2,
          liquidity: 0.15,
        },
      },
    }),
    common(),
    common({
      strategyId: 'defensive-exit',
      name: '防守退出',
      family: 'DEFENSIVE_EXIT',
      purpose: 'EXIT',
      eligibleRegimes: [
        'TREND_STRONG',
        'TRANSITION',
        'RANGE',
        'RISK_OFF',
        'UNKNOWN',
      ],
      entry: {
        type: 'ANY',
        conditions: [
          { field: 'marketRegime', op: 'EQ', value: 'RISK_OFF' },
          { field: 'technical.structureBreak', op: 'EQ', value: true },
          { field: 'technical.atrStopBroken', op: 'EQ', value: true },
        ],
      },
      positionSizing: {
        method: 'EQUAL_WEIGHT',
        allocationPct: 20,
        maxPositions: 5,
      },
      riskLimits: {
        maxPortfolioExposurePct: 70,
        maxStockWeightPct: 20,
        maxSectorExposurePct: 35,
        maxLossPct: 3,
        allowRiskIncrease: false,
      },
      modelDependencies: [{
        id: 'deterministic-risk-policy',
        type: 'FACTOR_SET',
        version: '1',
        required: true,
      }],
      score: {
        method: 'WEIGHTED_SUM',
        weights: {
          structureBreak: 0.45,
          relativeWeakness: 0.3,
          volatility: 0.25,
        },
      },
    }),
  ]
}

export function getStrategyCatalogV2() {
  const strategies = strategyCatalog()
  return {
    schemaVersion: 'strategy-catalog.v2',
    catalogVersion: `catalog.${strategies
      .map((item) => item.specVersion.slice('strategy.'.length))
      .join('.')}`,
    strategies,
  }
}

export function getStrategySpecV2(strategyId) {
  return getStrategyCatalogV2().strategies.find(
    (item) => item.strategyId === strategyId,
  ) || null
}
