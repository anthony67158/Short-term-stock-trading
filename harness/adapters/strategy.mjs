import {
  buildDefaultStrategyGovernance,
} from '../../shared/strategyGovernanceV2.js'
import {
  routeStrategyPortfolio,
} from '../../shared/strategyRouter.js'

function check(id, dimension, passed, message, options = {}) {
  return {
    id,
    dimension,
    passed: passed === true,
    message,
    hard: options.hard === true,
    code: options.code,
    details: options.details ?? null,
  }
}

export async function runStrategyHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const governance = buildDefaultStrategyGovernance(
    input.governance || {},
  )
  const route = routeStrategyPortfolio({
    marketRegime: input.marketRegime,
    context: input.context,
    governance,
    requestedAction: input.requestedAction,
  })
  const selected = route.production || route.research
  const matching = route.candidates.find(
    (item) => item.strategyId === expected.expectedStrategyId,
  )
  const checks = [
    check(
      'strategy-contract',
      'contract',
      route.schemaVersion === 'strategy-route.v1'
        && route.catalogVersion
        && route.candidates.length === 5,
      '策略路由契约或目录不完整',
      { hard: true, code: 'STRATEGY_ROUTE_CONTRACT_INVALID' },
    ),
    check(
      'strategy-grounding',
      'groundedness',
      selected?.strategyId === expected.expectedStrategyId
        && selected?.signalPassed === true
        && selected?.matchedRules?.length >= Number(
          expected.minimumMatchedRules || 1,
        ),
      '策略选择与输入证据或预期策略不一致',
      {
        hard: true,
        code: 'STRATEGY_ROUTE_NOT_GROUNDED',
        details: {
          selected: selected?.strategyId || null,
          expected: expected.expectedStrategyId,
        },
      },
    ),
    check(
      'strategy-production-isolation',
      'feasibility',
      expected.expectProduction === true
        ? route.production?.strategyId === expected.expectedStrategyId
        : route.production === null,
      '未晋级策略进入了生产路由',
      { hard: true, code: 'STRATEGY_PRODUCTION_ISOLATION_FAILED' },
    ),
    check(
      'strategy-actionability',
      'actionability',
      selected?.actionability === (
        expected.expectProduction === true ? 'READY' : 'SHADOW_ONLY'
      ),
      '策略可执行等级与治理状态不一致',
      { hard: true, code: 'STRATEGY_ACTIONABILITY_INVALID' },
    ),
    check(
      'strategy-regime-consistency',
      'consistency',
      matching?.regimeEligible === true
        && matching?.eligibleRegimes?.includes(input.marketRegime),
      '策略与市场状态不匹配',
      { hard: true, code: 'STRATEGY_REGIME_MISMATCH' },
    ),
  ]
  return {
    output: {
      route,
      selectedStrategyId: selected?.strategyId || null,
    },
    checks,
    metrics: {
      candidateCount: route.candidates.length,
      matchedRuleCount: selected?.matchedRules?.length || 0,
      productionCount: route.production ? 1 : 0,
    },
  }
}
