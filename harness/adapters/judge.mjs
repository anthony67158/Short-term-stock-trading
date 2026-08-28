import {
  confirmationPolicy,
  fuseConfirmation,
} from '../../shared/confirmPolicy.js'

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

export async function runJudgeHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const output = fuseConfirmation(input)
  const policy = confirmationPolicy(input.side)
  const deterministicScore = Number(input.deterministic?.score) || 0
  const stopOverride = input.side === 'stop'
    && input.deterministic?.decision === 'confirm'
    && deterministicScore >= Number(policy.hardOverride || Infinity)
  const llmAuthorizedConfirm = input.deterministic?.decision !== 'invalid'
    && input.llm?.decision === 'confirm'
    && Number(input.llm?.confidence) >= policy.llmConfidence
  const deterministicConfirm = !input.llm
    && input.deterministic?.decision === 'confirm'
    && deterministicScore >= policy.deterministicConfirm
  const confirmedSafely = output.decision !== 'confirm'
    || stopOverride
    || llmAuthorizedConfirm
    || deterministicConfirm
  const reasonIncludes = expected.reasonIncludes || []
  const checks = [
    check(
      'judge-contract',
      'contract',
      ['confirm', 'wait', 'invalid'].includes(output.decision)
        && !!output.policy,
      'Judge融合输出契约无效',
      { hard: true, code: 'JUDGE_CONTRACT_INVALID' },
    ),
    check(
      'judge-expected-decision',
      'contract',
      output.decision === expected.decision
        && (!expected.policy || output.policy === expected.policy),
      'Judge决策或策略路径与预期不一致',
      {
        hard: true,
        code: 'JUDGE_DECISION_MISMATCH',
        details: {
          actual: output.decision,
          policy: output.policy,
          expected: expected.decision,
        },
      },
    ),
    check(
      'judge-reason-grounding',
      'groundedness',
      reasonIncludes.every(
        (value) => String(output.reason || '').includes(value),
      ),
      'Judge理由未引用预期门禁证据',
      {
        code: 'JUDGE_REASON_UNGROUNDED',
        details: output.reason,
      },
    ),
    check(
      'judge-no-model-only-confirm',
      'groundedness',
      output.decision !== 'confirm'
        || input.deterministic?.decision !== 'invalid',
      '模型确认覆盖了客观失效信号',
      { hard: true, code: 'JUDGE_INVALID_OVERRIDE' },
    ),
    check(
      'judge-policy-thresholds',
      'feasibility',
      confirmedSafely,
      'Judge确认未满足客观分或置信度阈值',
      { hard: true, code: 'JUDGE_THRESHOLD_BYPASS' },
    ),
    check(
      'judge-observation-window',
      'feasibility',
      output.decision !== 'confirm'
        || !Number.isFinite(input.observationAgeMs)
        || input.observationAgeMs >= policy.minObserveMs,
      'Judge在最小观察期前确认',
      { hard: true, code: 'JUDGE_OBSERVATION_BYPASS' },
    ),
    check(
      'judge-actionable-reason',
      'actionability',
      !!String(output.reason || '').trim(),
      'Judge缺少用户可理解的后续理由',
      { code: 'JUDGE_REASON_MISSING' },
    ),
    check(
      'judge-wait-gate',
      'actionability',
      output.decision !== 'wait'
        || !!output.gated
        || ['llm-wait', 'deterministic-fallback'].includes(output.policy),
      'Judge等待结论缺少门禁归因',
      { code: 'JUDGE_WAIT_UNATTRIBUTED' },
    ),
    check(
      'judge-confidence-consistency',
      'consistency',
      output.decision !== 'confirm'
        || stopOverride
        || Number(output.confidence) >= policy.llmConfidence,
      '确认结论与置信度不一致',
      { hard: true, code: 'JUDGE_CONFIDENCE_INCONSISTENT' },
    ),
    check(
      'judge-side-policy',
      'consistency',
      ['buy', 'sell', 'stop'].includes(input.side),
      'Judge方向无法映射到已知策略',
      { hard: true, code: 'JUDGE_SIDE_INVALID' },
    ),
  ]
  return {
    output,
    checks,
    metrics: {
      deterministicScore,
      llmConfidence: Number.isFinite(Number(input.llm?.confidence))
        ? Number(input.llm.confidence)
        : null,
      policyThreshold: policy.llmConfidence,
    },
  }
}
