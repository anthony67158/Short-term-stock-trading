import {
  replayEvidenceSnapshot,
} from '../../shared/evidenceReplay.js'

function check(
  id,
  dimension,
  passed,
  message,
  {
    hard = false,
    code,
    details = null,
  } = {},
) {
  return {
    id,
    code,
    dimension,
    passed: passed === true,
    hard,
    message,
    details,
  }
}

function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

export async function runEvidenceHarnessCase(testCase) {
  const snapshot = testCase.input?.snapshot || {}
  const expected = testCase.expect || {}
  const output = replayEvidenceSnapshot(snapshot)
  const repeated = replayEvidenceSnapshot(structuredClone(snapshot))
  const expectedConstraints = expected.constraints || {}
  const constraintMismatches = Object.entries(expectedConstraints)
    .filter(([key, value]) => !same(output.constraints?.[key], value))
    .map(([key]) => key)
  const requiredFacts = expected.requiredFacts || []
  const missingFacts = requiredFacts.filter((path) => {
    const value = path.split('.').reduce(
      (current, key) => current?.[key],
      output,
    )
    return value == null || value === ''
  })
  const allowedFreshness = expected.allowedFreshness || ['LIVE', 'PARTIAL']
  const checks = [
    check(
      'replay-contract',
      'contract',
      output.schemaVersion === 'evidence-replay.v1'
        && output.replayable === expected.replayable,
      '证据快照不可确定性回放',
      { hard: true, code: 'EVIDENCE_REPLAY_INVALID' },
    ),
    check(
      'stable-fingerprint',
      'contract',
      output.fingerprint === repeated.fingerprint,
      '相同快照回放指纹不稳定',
      { hard: true, code: 'EVIDENCE_FINGERPRINT_UNSTABLE' },
    ),
    check(
      'source-schema',
      'groundedness',
      output.sourceSchemaVersion === snapshot.schemaVersion
        && output.security.code === snapshot.security?.code,
      '回放身份与原始证据不一致',
      { hard: true, code: 'EVIDENCE_IDENTITY_MISMATCH' },
    ),
    check(
      'required-facts',
      'groundedness',
      missingFacts.length === 0,
      '回放缺少要求的事实',
      {
        hard: true,
        code: 'EVIDENCE_FACT_MISSING',
        details: missingFacts,
      },
    ),
    check(
      'account-constraints',
      'feasibility',
      constraintMismatches.length === 0,
      '账户与T+1约束回放不一致',
      {
        hard: true,
        code: 'EVIDENCE_CONSTRAINT_MISMATCH',
        details: constraintMismatches,
      },
    ),
    check(
      'sellable-range',
      'feasibility',
      output.account.holdQty == null
        || output.account.sellableTodayQty == null
        || (
          output.account.sellableTodayQty >= 0
          && output.account.sellableTodayQty <= output.account.holdQty
        ),
      '今日可卖数量超出持仓范围',
      { hard: true, code: 'EVIDENCE_SELLABLE_INVALID' },
    ),
    check(
      'freshness-accepted',
      'actionability',
      allowedFreshness.includes(output.quality.freshness),
      '证据时效不满足当前场景要求',
      {
        code: 'EVIDENCE_FRESHNESS_REJECTED',
        details: output.quality.freshness,
      },
    ),
    check(
      'source-count',
      'actionability',
      output.quality.sourceCount >= Number(expected.minSourceCount || 0),
      '有效证据源数量不足',
      {
        code: 'EVIDENCE_SOURCE_COUNT_LOW',
        details: output.quality.sourceCount,
      },
    ),
    check(
      'quant-version-attribution',
      'consistency',
      expected.didFallback == null
        || output.quant.didFallback === expected.didFallback,
      '量化选择版本与实际运行版本归因错误',
      {
        hard: true,
        code: 'QUANT_VERSION_ATTRIBUTION_INVALID',
      },
    ),
    check(
      'constraint-consistency',
      'consistency',
      output.constraints.t1Locked == null
        || output.constraints.t1Locked
          === (Number(output.account.t1LockedQty) > 0),
      'T+1布尔约束与锁定数量不一致',
      { hard: true, code: 'T1_CONSTRAINT_INCONSISTENT' },
    ),
  ]
  return {
    output,
    checks,
    metrics: {
      sourceCount: output.quality.sourceCount,
      missingSourceCount: output.quality.missingSources.length,
      failedSourceCount: output.quality.failedSources.length,
      wallClockMs: output.quality.wallClockMs,
    },
  }
}
