import {
  compileExecutionPlan,
  recordExecutionFill,
  transitionExecutionPlan,
} from '../../shared/executionPlan.js'
import {
  createExecutionEvent,
  processExecutionEvent,
} from '../../shared/executionEvents.js'
import {
  attributeExecution,
} from '../../shared/executionAttribution.js'
import {
  evaluateAccountCircuitBreaker,
} from '../../shared/accountCircuitBreaker.js'
import {
  buildTGridExperiment,
  evaluateTGridEligibility,
} from '../../shared/tGridPolicy.js'

function check(id, dimension, passed, message, hard = true) {
  return {
    id,
    dimension,
    passed: passed === true,
    message,
    hard,
  }
}

function decision(input = {}) {
  return {
    schemaVersion: 'decision-plan.v2',
    decisionId: input.decisionId || 'decision.harness',
    action: input.action || 'REDUCE',
    actionLabel: input.actionLabel || '减仓',
    actionability: input.actionability || 'READY',
    asOf: input.asOf || '2026-08-21T02:00:00.000Z',
    validUntil: input.validUntil || '2026-08-21T03:00:00.000Z',
    quantity: { lots: input.lots || 2 },
    prices: {
      reference: input.referencePrice || 10,
      stop: input.stopPrice || 9.5,
      target: input.targetPrice || 11,
    },
    costs: {
      estimatedFees: 8,
      estimatedNetAmount: (input.lots || 2)
        * (input.referencePrice || 10) * 100,
    },
    trigger: '到价后确认',
    invalidation: '结构失效',
    evidenceIds: ['ev_harness'],
  }
}

function lifecycleScenario(input) {
  const draft = compileExecutionPlan({
    decisionPlan: decision(input),
    code: input.code || '600000',
    accountRevision: 1,
    now: Date.parse('2026-08-21T02:00:00.000Z'),
  })
  const armed = transitionExecutionPlan(draft, 'ARM', { now: 2 })
  const alerted = transitionExecutionPlan(armed, 'PRICE_TRIGGERED', {
    now: 3,
    price: input.triggeredPrice || 10.1,
  })
  const confirmed = transitionExecutionPlan(
    alerted,
    'USER_CONFIRM',
    { now: 4 },
  )
  const completed = recordExecutionFill(confirmed, {
    fillId: 'fill-harness',
    lots: draft.targetLots,
    price: input.fillPrice || 10.1,
    fee: 5,
    at: 5,
    manuallyRecorded: true,
  })
  return { draft, armed, alerted, confirmed, completed }
}

function includesAll(values = [], expected = []) {
  return expected.every((item) => values.includes(item))
}

function eventScenario(input) {
  const event = createExecutionEvent({
    type: input.eventType,
    code: input.code || '600000',
    sourceAsOf: input.sourceAsOf || '2026-08-21T10:30:00+08:00',
    payload: input.payload || {},
  }, 1)
  const first = processExecutionEvent(
    { processed: {}, history: [] },
    event,
    2,
  )
  const replay = processExecutionEvent(first.state, event, 3)
  return { event, first, replay }
}

export async function runExecutionHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  let output
  let checks
  if (input.scenario === 'lifecycle') {
    output = lifecycleScenario(input)
    checks = [
      check(
        'execution-contract',
        'contract',
        output.draft.schemaVersion === 'execution-plan.v1',
        '执行计划契约无效',
      ),
      check(
        'execution-evidence-binding',
        'groundedness',
        includesAll(
          output.draft.evidenceIds,
          expected.evidenceIds || ['ev_harness'],
        ),
        '执行计划没有绑定决策证据',
      ),
      check(
        'execution-lots-feasible',
        'feasibility',
        output.draft.slices.reduce(
          (sum, slice) => sum + Number(slice.lots || 0),
          0,
        ) === output.draft.targetLots
          && output.completed.remainingLots === 0,
        '分批手数或剩余手数不一致',
      ),
      check(
        'execution-manual-completion',
        'actionability',
        output.completed.status === 'COMPLETED'
          && output.completed.fills.every(
            (fill) => fill.manuallyRecorded === true,
          ),
        '非人工成交推进了完成状态',
      ),
      check(
        'execution-lifecycle-order',
        'consistency',
        output.confirmed.status === 'USER_CONFIRMED',
        '人工执行状态迁移顺序错误',
      ),
    ]
  } else if (input.scenario === 'event') {
    output = eventScenario(input)
    checks = [
      check(
        'event-contract',
        'contract',
        output.event.schemaVersion === 'execution-event.v1',
        '执行事件契约无效',
      ),
      check(
        'event-source-binding',
        'groundedness',
        output.event.sourceAsOf === (
          input.sourceAsOf || '2026-08-21T10:30:00+08:00'
        ),
        '执行事件没有绑定源数据时点',
      ),
      check(
        'event-deterministic-path',
        'feasibility',
        output.first.decision.runDeterministic === true,
        '唯一事件没有执行确定性重算',
      ),
      check(
        'event-llm-policy',
        'actionability',
        output.first.decision.runLlm === expected.runLlm,
        '事件LLM调用策略错误',
      ),
      check(
        'event-idempotency',
        'consistency',
        output.first.duplicate === false
          && output.replay.duplicate === true
          && output.replay.state.history.length === 1,
        '重复事件未被幂等拦截',
      ),
    ]
  } else if (input.scenario === 'circuit') {
    output = evaluateAccountCircuitBreaker(input)
    checks = [
      check(
        'circuit-contract',
        'contract',
        output.schemaVersion === 'account-circuit-breaker.v1',
        '账户熔断契约无效',
      ),
      check(
        'circuit-grounded-blockers',
        'groundedness',
        includesAll(
          output.blockerCodes,
          expected.blockerCodes || [],
        ),
        '账户熔断没有命中预期风险事实',
      ),
      check(
        'circuit-risk-increase',
        'actionability',
        output.allowRiskIncrease === expected.allowRiskIncrease,
        '账户熔断结果错误',
      ),
      check(
        'circuit-cash-reservation',
        'feasibility',
        output.pendingSellProceedsRecognized === 0,
        '未完成卖出提前释放了现金',
      ),
      check(
        'circuit-cash-consistency',
        'consistency',
        output.availableCashAfterReservations
          === Number(expected.availableCashAfterReservations),
        '买入现金占用与可用现金不一致',
      ),
    ]
  } else if (input.scenario === 'grid') {
    const eligibility = evaluateTGridEligibility(input)
    output = buildTGridExperiment({
      eligibility,
      referencePrice: input.referencePrice,
      baseLots: input.baseLots,
      maxNetBuyLots: input.maxNetBuyLots,
      atrPct: input.atrPct,
    })
    checks = [
      check(
        'grid-contract',
        'contract',
        output.schemaVersion === 't-grid-experiment.v1',
        '做T实验契约无效',
      ),
      check(
        'grid-eligibility',
        'groundedness',
        output.eligible === expected.eligible,
        '做T网格适用状态错误',
      ),
      check(
        'grid-no-auto-order',
        'actionability',
        output.automaticExecution === false,
        '做T实验不得自动下单',
      ),
      check(
        'grid-lot-limit',
        'feasibility',
        !output.eligible || output.levels.every(
          (item) =>
            Number(item.lots) > 0
            && Number(item.lots) <= Number(output.maximumNetBuyLots),
        ),
        '做T实验手数超过净买入上限',
      ),
      check(
        'grid-eligibility-consistency',
        'consistency',
        output.eligible === eligibility.eligible
          && (
            output.eligible
            || includesAll(
              output.reasons,
              expected.reasonCodes || [],
            )
          ),
        '做T准入和实验输出不一致',
      ),
    ]
  } else {
    const lifecycle = lifecycleScenario(input)
    output = attributeExecution(lifecycle.completed, {
      fills: lifecycle.completed.fills,
      vwap: input.vwap || 10,
      netPnl: input.netPnl,
      validationComplete: true,
    })
    checks = [
      check(
        'attribution-contract',
        'contract',
        output.schemaVersion === 'execution-attribution.v1',
        '执行归因契约无效',
      ),
      check(
        'attribution-costs',
        'groundedness',
        output.totalFees > 0
          && Number.isFinite(output.decisionSlippageBps),
        '成交费用或滑点未归因',
      ),
      check(
        'attribution-completion',
        'feasibility',
        output.status === 'COMPLETED'
          && output.fillRatePct === 100,
        '完整人工成交没有形成完整归因',
      ),
      check(
        'attribution-learning-gate',
        'actionability',
        output.learningEligible === expected.learningEligible,
        '真实结果学习门禁错误',
      ),
      check(
        'attribution-plan-consistency',
        'consistency',
        output.planId === lifecycle.completed.planId
          && output.decisionId === lifecycle.completed.decisionId,
        '归因没有绑定原执行计划',
      ),
    ]
  }
  return {
    output,
    checks,
    metrics: {
      checks: checks.length,
      passed: checks.filter((item) => item.passed).length,
    },
  }
}
