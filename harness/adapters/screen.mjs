import {
  normalizePickDecision,
  rankStrategyShortlist,
} from '../../shared/stockRanking.js'

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

export async function runScreenHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const shortlist = rankStrategyShortlist(
    input.candidates || [],
    input.options || {},
  )
  const allowedCodes = shortlist.list.map((item) => String(item.code))
  const decision = normalizePickDecision(
    input.modelOutput || {},
    allowedCodes,
    shortlist.list,
  )
  const picks = Array.isArray(decision.picks) ? decision.picks : []
  const pickCodes = new Set(picks.map((item) => String(item.code)))
  const unknownCodes = picks
    .map((item) => String(item.code))
    .filter((code) => !allowedCodes.includes(code))
  const failedStrategy = new Set(
    shortlist.watchlist.map((item) => String(item.code)),
  )
  const upgradedFailed = picks.filter((item) =>
    failedStrategy.has(String(item.code))
    && item.actionability === '可执行'
  )
  const missingRequired = (expected.requiredPickCodes || [])
    .map(String)
    .filter((code) => !pickCodes.has(code))
  const forbiddenPresent = (expected.forbiddenPickCodes || [])
    .map(String)
    .filter((code) => pickCodes.has(code))
  const conditionalIncomplete = picks.filter((item) =>
    item.actionability === '等待触发'
    && !(item.buyPoint || item.buyZone || item.risk)
  )
  const checks = [
    check(
      'screen-contract',
      'contract',
      Array.isArray(decision.picks)
        && typeof decision.noTrade === 'boolean'
        && !!shortlist.specVersion,
      '选股输出契约无效',
      { hard: true, code: 'SCREEN_CONTRACT_INVALID' },
    ),
    check(
      'screen-required-picks',
      'contract',
      missingRequired.length === 0,
      '期望候选未保留',
      {
        code: 'SCREEN_EXPECTED_PICK_MISSING',
        details: missingRequired,
      },
    ),
    check(
      'screen-code-whitelist',
      'groundedness',
      unknownCodes.length === 0,
      '模型输出候选池外股票',
      {
        hard: true,
        code: 'SCREEN_CODE_NOT_ALLOWED',
        details: unknownCodes,
      },
    ),
    check(
      'screen-forbidden-picks',
      'groundedness',
      forbiddenPresent.length === 0,
      '禁止股票进入选股结果',
      {
        hard: true,
        code: 'SCREEN_FORBIDDEN_PICK',
        details: forbiddenPresent,
      },
    ),
    check(
      'screen-strategy-gate',
      'feasibility',
      upgradedFailed.length === 0,
      '未通过策略的候选被升级为可执行',
      {
        hard: true,
        code: 'SCREEN_STRATEGY_GATE_BYPASS',
        details: upgradedFailed.map((item) => item.code),
      },
    ),
    check(
      'screen-pick-limit',
      'feasibility',
      picks.length <= 3,
      '选股结果超过最多三只限制',
      { hard: true, code: 'SCREEN_PICK_LIMIT_EXCEEDED' },
    ),
    check(
      'screen-conditional-plan',
      'actionability',
      conditionalIncomplete.length === 0,
      '等待触发候选缺少买点或风险条件',
      {
        code: 'SCREEN_CONDITIONAL_PLAN_MISSING',
        details: conditionalIncomplete.map((item) => item.code),
      },
    ),
    check(
      'screen-no-trade-reason',
      'actionability',
      decision.noTrade !== true
        || !!String(decision.noTradeReason || '').trim(),
      '不出手结论缺少原因',
      { code: 'SCREEN_NO_TRADE_REASON_MISSING' },
    ),
    check(
      'screen-strategy-version',
      'consistency',
      shortlist.strategyId
        && shortlist.specVersion
        && shortlist.list.every((item) => item.strategySignal),
      '候选缺少统一策略版本或信号',
      { hard: true, code: 'SCREEN_STRATEGY_VERSION_MISSING' },
    ),
    check(
      'screen-no-trade-consistency',
      'consistency',
      decision.noTrade === true
        ? picks.every((item) => item.actionability !== '可执行')
        : picks.some((item) => item.actionability === '可执行'),
      'noTrade与候选可执行状态矛盾',
      { hard: true, code: 'SCREEN_NO_TRADE_INCONSISTENT' },
    ),
  ]
  return {
    output: {
      strategyId: shortlist.strategyId,
      specVersion: shortlist.specVersion,
      signalPassedCount: shortlist.signalPassedCount,
      shortlist: shortlist.list,
      decision,
    },
    checks,
    metrics: {
      candidateCount: (input.candidates || []).length,
      shortlistCount: shortlist.list.length,
      executableCount: picks.filter(
        (item) => item.actionability === '可执行',
      ).length,
    },
  }
}
