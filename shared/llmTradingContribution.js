export const LLM_TRADING_CONTRIBUTION_SCHEMA_VERSION =
  'llm-trading-contribution.v1'

function text(value, maximum = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function contribution(key, label, value) {
  const evidence = text(value)
  return evidence ? { key, label, evidence } : null
}

export function buildLLMTradingContribution({
  mode,
  role,
  model,
  result = {},
  payload = {},
  usedRag = false,
  searchReference = null,
} = {}) {
  const triggeredReview = !!payload.reviewEvent
  const contributions = [
    contribution(
      'CATALYST_INTERPRETATION',
      '消息与催化解释',
      result.newsNote
        || (
          searchReference
            ? `核对了${searchReference.provider || '联网检索'}线索`
            : ''
        ),
    ),
    contribution(
      'COUNTER_CASE',
      '最强反方检验',
      result.bearCase || result.counterCase,
    ),
    contribution(
      'INVALIDATION',
      '失效条件提炼',
      result.invalidation,
    ),
    contribution(
      'THEORY_CONTEXT',
      '交易经验校准',
      result.theoryNote || result.theory,
    ),
    contribution(
      'MONITORING_RULES',
      '监控条件建议',
      Array.isArray(result.executionRules)
        && result.executionRules.length
        ? `${result.executionRules.length}条候选规则已交由服务端校验`
        : '',
    ),
    contribution(
      'TRIGGER_REVIEW',
      '触价后的确认或放弃判断',
      triggeredReview
        ? (
            result.reviewDecision?.reason
            || result.reason
            || result.actionPlan
          )
        : '',
    ),
  ].filter(Boolean)

  return {
    schemaVersion: LLM_TRADING_CONTRIBUTION_SCHEMA_VERSION,
    used: true,
    role: text(role, 40) || null,
    model: text(model, 100) || null,
    mode: text(mode, 40) || null,
    scope: triggeredReview
      ? 'TRIGGER_REVIEW'
      : mode === 'hold_advice'
        ? 'HOLDING_INTERPRETATION'
        : mode === 'buy_advice'
          ? 'ENTRY_INTERPRETATION'
          : 'ANALYSIS',
    contributions,
    evidenceAugmentation: {
      retrievalUsed: usedRag === true,
      webSearchUsed: !!searchReference,
    },
    authority: {
      canIncreaseRisk: false,
      action: 'SERVER_VALIDATED',
      price: 'SERVER',
      quantity: 'SERVER',
      expectancy: 'SERVER',
      accountRisk: 'SERVER',
    },
    serverValidation: {
      decisionPlan: result.decisionPlan?.schemaVersion || null,
      actionability: result.decisionPlan?.actionability || null,
      policyAdjusted: !!result.serverAdjust,
    },
  }
}
