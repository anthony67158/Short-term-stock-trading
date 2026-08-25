import {
  reconcileAdviceNumbers,
} from '../../shared/adviceValidation.js'
import { compileDecisionPlan } from '../../shared/decisionPlan.js'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function hands(value) {
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)\s*手/)
  const number = match ? Number(match[1]) : Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function item(id, dimension, passed, message, options = {}) {
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

export async function runAdviceHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const reconciled = reconcileAdviceNumbers({
    mode: input.mode,
    result: input.result,
    payload: input.payload,
  })
  const result = reconciled.result
  const decisionPlan = input.compileDecisionPlan === true
    ? compileDecisionPlan({
        mode: input.mode,
        advice: result,
        payload: input.payload,
        evidenceSnapshot: input.evidenceSnapshot || null,
        now: Number(input.now) || Date.now(),
      })
    : null
  if (decisionPlan) result.decisionPlan = decisionPlan
  const action = String(result.action || result.stance || '')
  const isBuy = input.mode === 'buy_advice'
  const quantity = isBuy
    ? hands(result.planQtyNum ?? result.planQty)
    : hands(result.opQty)
  const price = isBuy
    ? finite(result.buyPrice)
    : /加仓/.test(action)
      ? finite(result.addPrice)
      : finite(result.reducePrice ?? result.stopPrice)
  const amount = isBuy
    ? finite(result.planAmount) || 0
    : finite(result.opAmount) || 0
  const computedAmount = price != null ? Math.round(
    price * quantity * 100,
  ) : 0
  const cash = finite(input.payload?.account?.cash)
  const sellable = finite(input.payload?.sellableTodayQty)
  const selling = /减仓|清仓|卖出/.test(action)
    || /减仓|清仓|卖出/.test(String(result.opQty || ''))
  const actionable = isBuy
    ? !/观望|等待|不建议/.test(action)
    : /加仓|减仓|清仓|卖出/.test(action)
  const issueText = reconciled.issues.join('；')
  const forbiddenText = expected.forbiddenText || []
  const requiredIssues = expected.requiredIssueIncludes || []
  const forbiddenIssues = expected.forbiddenIssueIncludes || []
  const checks = [
    item(
      'advice-contract',
      'contract',
      !!result
        && typeof result === 'object'
        && reconciled.valid === expected.expectedValid,
      '建议标准化契约或有效性不符合预期',
      { hard: true, code: 'ADVICE_CONTRACT_INVALID' },
    ),
    item(
      'expected-action',
      'contract',
      !expected.expectedAction
        || action === expected.expectedAction,
      '建议动作与安全预期不一致',
      {
        hard: true,
        code: 'ADVICE_ACTION_MISMATCH',
        details: { actual: action, expected: expected.expectedAction },
      },
    ),
    item(
      'forbidden-text',
      'groundedness',
      forbiddenText.every(
        (value) => !JSON.stringify(result).includes(String(value)),
      ),
      '建议残留禁止文本或编造事实',
      { hard: true, code: 'ADVICE_FORBIDDEN_TEXT' },
    ),
    item(
      'issue-attribution',
      'groundedness',
      requiredIssues.every((value) => issueText.includes(value))
        && forbiddenIssues.every((value) => !issueText.includes(value)),
      '服务端修正原因归因不准确',
      {
        code: 'ADVICE_ISSUE_ATTRIBUTION_INVALID',
        details: reconciled.issues,
      },
    ),
    item(
      'expected-quantity',
      'feasibility',
      expected.expectedQty == null
        || quantity === Number(expected.expectedQty),
      '建议手数不符合账户约束',
      {
        hard: true,
        code: 'ADVICE_QUANTITY_MISMATCH',
        details: { quantity, expected: expected.expectedQty },
      },
    ),
    item(
      'cash-limit',
      'feasibility',
      !actionable
        || !isBuy
        || cash == null
        || amount <= cash,
      '建议买入金额超过可用现金',
      { hard: true, code: 'ADVICE_CASH_EXCEEDED' },
    ),
    item(
      't1-limit',
      'feasibility',
      !selling || sellable == null || quantity <= sellable,
      '建议卖出手数超过今日可卖量',
      { hard: true, code: 'ADVICE_T1_EXCEEDED' },
    ),
    item(
      'actionable-fields',
      'actionability',
      actionable
        ? quantity > 0 && price > 0
        : quantity === 0
          && !!String(result.actionPlan || result.timing || result.reason || ''),
      '建议缺少可执行数量价格或等待条件',
      { code: 'ADVICE_NOT_ACTIONABLE' },
    ),
    item(
      'invalidation',
      'actionability',
      !actionable
        || !!String(
          result.invalidation
          || result.exitTiming
          || result.stopPrice
          || '',
        ),
      '可执行建议缺少失效或退出条件',
      { code: 'ADVICE_INVALIDATION_MISSING' },
    ),
    item(
      'amount-conservation',
      'consistency',
      !actionable || amount === computedAmount,
      '建议金额与价格手数不守恒',
      {
        hard: true,
        code: 'ADVICE_AMOUNT_MISMATCH',
        details: { amount, computedAmount },
      },
    ),
    item(
      'price-relationship',
      'consistency',
      !isBuy
        || !actionable
        || (
          Number(result.stopPrice) < Number(result.buyPrice)
          && Number(result.targetPrice) > Number(result.buyPrice)
        ),
      '买入、止损和目标价关系不一致',
      { hard: true, code: 'ADVICE_PRICE_RELATION_INVALID' },
    ),
    item(
      'decision-plan-contract',
      'contract',
      input.compileDecisionPlan !== true
        || decisionPlan?.schemaVersion === 'decision-plan.v2',
      '统一决策计划契约缺失',
      { hard: true, code: 'DECISION_PLAN_CONTRACT_INVALID' },
    ),
    item(
      'decision-plan-actionability',
      'actionability',
      !expected.expectedDecisionActionability
        || decisionPlan?.actionability
          === expected.expectedDecisionActionability,
      '统一决策计划可执行等级与预期不一致',
      {
        hard: true,
        code: 'DECISION_PLAN_ACTIONABILITY_MISMATCH',
        details: {
          actual: decisionPlan?.actionability,
          expected: expected.expectedDecisionActionability,
        },
      },
    ),
    item(
      'decision-plan-final-action',
      'consistency',
      !expected.expectedDecisionAction
        || decisionPlan?.action === expected.expectedDecisionAction,
      '统一决策计划最终动作与预期不一致',
      {
        hard: true,
        code: 'DECISION_PLAN_ACTION_MISMATCH',
      },
    ),
    item(
      'decision-plan-costs',
      'feasibility',
      input.compileDecisionPlan !== true
        || decisionPlan?.quantity?.lots === 0
        || (
          Number(decisionPlan?.costs?.estimatedFees) > 0
          && Number(decisionPlan?.costs?.estimatedNetAmount) > 0
        ),
      '统一决策计划没有计入交易费用',
      { hard: true, code: 'DECISION_PLAN_COSTS_MISSING' },
    ),
  ]
  return {
    output: {
      mode: input.mode,
      valid: reconciled.valid,
      issues: reconciled.issues,
      result,
    },
    checks,
    metrics: {
      issueCount: reconciled.issues.length,
      quantity,
      amount,
    },
  }
}
