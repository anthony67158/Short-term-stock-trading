import {
  buildDailySummary,
} from '../../api/_daily_summary.js'

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

export async function runDailyHarnessCase(testCase) {
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const result = input.result || {}
  const report = result.report || {}
  const output = buildDailySummary(result)
  const text = String(output?.text || '')
  const requiredText = expected.requiredText || []
  const forbiddenText = expected.forbiddenText || []
  const sectors = Array.isArray(report.sectors) ? report.sectors : []
  const invalidRatings = sectors.filter(
    (item) => !['看多', '中性', '看空'].includes(item?.rating),
  )
  const namedSectors = new Set(
    sectors.map((item) => String(item?.name || '')),
  )
  const missingSectors = (expected.requiredSectors || [])
    .filter((name) => !namedSectors.has(String(name)))
  const checks = [
    check(
      'daily-summary-contract',
      'contract',
      !!output
        && output.day === result.day
        && output.session === result.session
        && typeof output.text === 'string',
      '策略日报摘要契约无效',
      { hard: true, code: 'DAILY_SUMMARY_CONTRACT_INVALID' },
    ),
    check(
      'daily-sector-contract',
      'contract',
      invalidRatings.length === 0 && missingSectors.length === 0,
      '策略日报板块评级或覆盖不完整',
      {
        code: 'DAILY_SECTOR_CONTRACT_INVALID',
        details: {
          invalid: invalidRatings.map((item) => item?.name),
          missing: missingSectors,
        },
      },
    ),
    check(
      'daily-required-facts',
      'groundedness',
      requiredText.every((value) => text.includes(String(value))),
      '日报摘要遗漏要求的市场事实',
      {
        hard: true,
        code: 'DAILY_REQUIRED_FACT_MISSING',
        details: requiredText.filter(
          (value) => !text.includes(String(value)),
        ),
      },
    ),
    check(
      'daily-forbidden-facts',
      'groundedness',
      forbiddenText.every((value) => !text.includes(String(value))),
      '日报摘要包含禁止或编造事实',
      { hard: true, code: 'DAILY_FORBIDDEN_FACT' },
    ),
    check(
      'daily-time-coordinate',
      'feasibility',
      /^\d{4}-\d{2}-\d{2}$/.test(String(result.day || ''))
        && ['morning', 'noon', 'evening'].includes(result.session),
      '日报缺少合法交易日或场次',
      { hard: true, code: 'DAILY_TIME_INVALID' },
    ),
    check(
      'daily-risk-list',
      'feasibility',
      Array.isArray(report.risks) && report.risks.length > 0,
      '日报缺少风险清单',
      { code: 'DAILY_RISK_MISSING' },
    ),
    check(
      'daily-strategy',
      'actionability',
      !!String(report.strategy || '').trim(),
      '日报缺少仓位或节奏策略',
      { code: 'DAILY_STRATEGY_MISSING' },
    ),
    check(
      'daily-direction-summary',
      'actionability',
      sectors.length > 0
        && sectors.some((item) =>
          ['看多', '看空'].includes(item.rating)
        ),
      '日报没有形成可识别的板块方向',
      { code: 'DAILY_DIRECTION_MISSING' },
    ),
    check(
      'daily-search-version',
      'consistency',
      expected.searchEnabled == null
        || (
          output.searchEnabled === expected.searchEnabled
          && output.searchConfigUpdatedAt
            === Number(result.searchConfigUpdatedAt || 0)
        ),
      '日报摘要与检索配置版本不一致',
      { hard: true, code: 'DAILY_SEARCH_VERSION_MISMATCH' },
    ),
    check(
      'daily-session-consistency',
      'consistency',
      output.sessionCn === result.sessionCn
        && text.includes(result.day),
      '日报摘要场次与正文不一致',
      { hard: true, code: 'DAILY_SESSION_MISMATCH' },
    ),
  ]
  return {
    output,
    checks,
    metrics: {
      summaryChars: text.length,
      sectorCount: sectors.length,
      riskCount: Array.isArray(report.risks)
        ? report.risks.length
        : 0,
    },
  }
}
