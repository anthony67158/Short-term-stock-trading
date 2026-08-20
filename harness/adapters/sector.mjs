import {
  buildSectorForecastFeatures,
  mergeSectorForecastExplanation,
  rankSectorForecasts,
  scoreSectorForecast,
  SECTOR_FORECAST_SCHEMA_VERSION,
} from '../../shared/sectorForecast.js'

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

export async function runSectorHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const scored = (input.items || []).map((item) =>
    scoreSectorForecast(buildSectorForecastFeatures(item))
  )
  const ranked = rankSectorForecasts(
    scored,
    input.horizon === 'week' ? 'week' : 'next',
  )
  const modelByCode = new Map(
    (input.modelOutput || [])
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item]),
  )
  const explained = ranked.map((item) =>
    mergeSectorForecastExplanation(
      item,
      modelByCode.get(String(item.code)) || {},
    )
  )
  const byCode = new Map(explained.map((item) => [item.code, item]))
  const expectedPhases = expected.phases || {}
  const expectedActions = expected.actions || {}
  const forbiddenActions = expected.forbiddenActions || {}
  const phaseMismatches = Object.entries(expectedPhases)
    .filter(([code, phase]) => byCode.get(code)?.phase !== phase)
  const actionMismatches = Object.entries(expectedActions)
    .filter(([code, action]) => byCode.get(code)?.actionability !== action)
  const forbiddenPresent = Object.entries(forbiddenActions)
    .filter(([code, actions]) =>
      (actions || []).includes(byCode.get(code)?.actionability)
    )
  const deterministicFields = [
    'rank',
    'phase',
    'actionability',
  ]
  const mutations = explained.flatMap((item) => {
    const original = ranked.find((entry) => entry.code === item.code)
    return deterministicFields
      .filter((field) => item[field] !== original?.[field])
      .map((field) => `${item.code}.${field}`)
  })
  const unsafeLayouts = explained.filter((item) =>
    item.actionability === 'LAYOUT'
    && (
      Number(item.penalties?.crowding || 0) > 0
      || Number(item.penalties?.divergence || 0) > 0
      || Number(item.penalties?.missingData || 0) > 0
    )
  )
  const checks = [
    check(
      'sector-contract',
      'contract',
      explained.length > 0
        && explained.every((item) =>
          item.schemaVersion === SECTOR_FORECAST_SCHEMA_VERSION
          && /^BK\d{4}$/.test(item.code)
          && Number.isFinite(item.rank)
          && Number.isFinite(item.forecast?.next?.score)
          && Number.isFinite(item.forecast?.week?.score)
        ),
      '板块前瞻输出契约无效',
      { hard: true, code: 'SECTOR_CONTRACT_INVALID' },
    ),
    check(
      'sector-phase',
      'groundedness',
      phaseMismatches.length === 0,
      '板块生命周期与客观证据不一致',
      {
        code: 'SECTOR_PHASE_MISMATCH',
        details: phaseMismatches,
      },
    ),
    check(
      'sector-llm-boundary',
      'groundedness',
      mutations.length === 0,
      'LLM解释覆盖了确定性字段',
      {
        hard: true,
        code: 'SECTOR_LLM_OVERRIDE',
        details: mutations,
      },
    ),
    check(
      'sector-safety-gates',
      'feasibility',
      unsafeLayouts.length === 0,
      '过热、背离或缺失数据板块被标为可布局',
      {
        hard: true,
        code: 'SECTOR_LAYOUT_GATE_BYPASS',
        details: unsafeLayouts.map((item) => item.code),
      },
    ),
    check(
      'sector-forbidden-actions',
      'feasibility',
      forbiddenPresent.length === 0,
      '板块输出了场景禁止动作',
      {
        hard: true,
        code: 'SECTOR_FORBIDDEN_ACTION',
        details: forbiddenPresent,
      },
    ),
    check(
      'sector-expected-actions',
      'actionability',
      actionMismatches.length === 0,
      '板块动作等级与预期不一致',
      {
        code: 'SECTOR_ACTION_MISMATCH',
        details: actionMismatches,
      },
    ),
    check(
      'sector-top-rank',
      'actionability',
      !expected.topCode || explained[0]?.code === expected.topCode,
      '预期板块未排在首位',
      {
        code: 'SECTOR_TOP_RANK_MISMATCH',
        details: {
          actual: explained[0]?.code,
          expected: expected.topCode,
        },
      },
    ),
    check(
      'sector-rank-continuity',
      'consistency',
      explained.every((item, index) => item.rank === index + 1),
      '板块排名不连续或不稳定',
      { hard: true, code: 'SECTOR_RANK_INVALID' },
    ),
    check(
      'sector-explanation-shape',
      'consistency',
      explained.every((item) =>
        item.explanation
        && Array.isArray(item.explanation.catalysts)
        && Array.isArray(item.explanation.risks)
        && Array.isArray(item.explanation.evidence)
      ),
      '板块解释白名单结构缺失',
      { code: 'SECTOR_EXPLANATION_INVALID' },
    ),
  ]
  return {
    output: {
      schemaVersion: SECTOR_FORECAST_SCHEMA_VERSION,
      horizon: input.horizon === 'week' ? 'week' : 'next',
      sectors: explained,
    },
    checks,
    metrics: {
      sectorCount: explained.length,
      layoutCount: explained.filter(
        (item) => item.actionability === 'LAYOUT',
      ).length,
      guardedCount: explained.filter(
        (item) => item.actionability !== 'LAYOUT',
      ).length,
    },
  }
}
