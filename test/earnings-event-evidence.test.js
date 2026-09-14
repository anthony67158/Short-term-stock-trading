import test from 'node:test'
import assert from 'node:assert/strict'
import { auditForecasts, inspectOriginal, nextSessionAfterDisclosure,
  sourceCalendarDate, validDate, inspectExpectations } from '../backtest/earnings/evidence.mjs'

const row = (overrides = {}) => ({
  ts_code: '600000.SH', ann_date: '20250711', first_ann_date: '20250711',
  end_date: '20250630', net_profit_min: 10000, net_profit_max: 12000,
  last_parent_net: 9000, p_change_min: 11.11, p_change_max: 33.33, type: '预增',
  ...overrides,
})

test('invalid dates and codes are rejected rather than normalized into another day', () => {
  assert.equal(validDate('20250230'), false)
  assert.equal(validDate('20240229'), true)
  assert.deepEqual(auditForecasts([row({ ann_date: '20250230' }), row({ ts_code: '../x' })]).invalidRows, [0, 1])
})

test('forecast amounts are converted from ten-thousand CNY without claiming surprise', () => {
  const event = auditForecasts([row()]).events[0]
  assert.deepEqual(event.forecastRangeCny, [100000000, 120000000])
  assert.equal(event.marketSurprise, null)
  assert.equal(event.productionEligible, false)
})

test('same-day identical rows are counted once but conflicts are quarantined', () => {
  const duplicate = auditForecasts([row(), row()]).events[0]
  assert.equal(duplicate.earliestValueDuplicateRows, 1)
  assert.deepEqual(duplicate.reasons, [])
  const conflict = auditForecasts([row(), row({ net_profit_min: 11000 })]).events[0]
  assert.ok(conflict.reasons.includes('FIRST_DATE_VALUE_CONFLICT'))
})

test('a missing original announcement cannot be replaced by its latest revision', () => {
  const event = auditForecasts([row({ first_ann_date: '20250430' })]).events[0]
  assert.ok(event.reasons.includes('EARLIER_FIRST_ANNOUNCEMENT_NOT_IN_ROWS'))
})

test('later revisions never overwrite the values of the earliest recorded event', () => {
  const first = auditForecasts([row()]).events[0]
  const withRevision = auditForecasts([row({ ann_date: '20250801', net_profit_min: 1 }), row()]).events[0]
  assert.deepEqual(first.firstRow, withRevision.firstRow)
  assert.deepEqual(first.reasons, withRevision.reasons)
  assert.equal(withRevision.laterChangedValueRows, 1)
})

test('missing, nonnumeric and reversed profit intervals fail evidence checks', () => {
  for (const overrides of [
    { net_profit_min: null }, { net_profit_max: '12000' }, { net_profit_min: 20000 },
  ]) assert.ok(auditForecasts([row(overrides)]).events[0].reasons.some(reason => reason.startsWith('PROFIT_RANGE')))
})

test('source date uses Shanghai timezone and never permits same-date trading', () => {
  assert.equal(sourceCalendarDate(Date.parse('2025-07-11T17:01:00Z')), '20250712')
  assert.equal(nextSessionAfterDisclosure('20250711', ['20250711', '20250714']), '20250714')
  assert.equal(nextSessionAfterDisclosure('20250714', ['20250711', '20250714']), null)
  assert.throws(() => nextSessionAfterDisclosure('20250230', []))
})

test('finding two numbers in a PDF is not original-table validation or market surprise', () => {
  const event = auditForecasts([row()]).events[0]
  const source = { completeWithinScope: true, documents: [{
    announcement: { announcementId: 'a', announcementTitle: '2025年半年度业绩预告',
      announcementTime: Date.parse('2025-07-11T00:00:00+08:00') },
    pdf: { sha256: 'a'.repeat(64), url: 'https://static.cninfo.com.cn/test.pdf' },
  }] }
  const result = inspectOriginal(event, source, { a: `${'公告正文'.repeat(50)}10000 12000` })
  assert.equal(result.original.numericTokenMatch, true)
  assert.equal(result.original.precision, 'DATE_ONLY')
  assert.equal(result.state, 'BLOCKED_EVIDENCE')
  assert.equal(result.expectedReturn, null)
  assert.ok(result.reasons.includes('POINT_IN_TIME_EXPECTATION_MISSING'))
  assert.ok(result.reasons.includes('ORIGINAL_PROFIT_TABLE_NOT_SEMANTICALLY_VERIFIED'))
})

test('earlier original disclosures and correction-only matches do not pass first-event gate', () => {
  const event = auditForecasts([row()]).events[0]
  const result = inspectOriginal(event, { completeWithinScope: true, documents: [
    { announcement: { announcementId: 'early', announcementTitle: '2025年半年度业绩快报',
      announcementTime: Date.parse('2025-07-10T00:00:00+08:00') } },
    { announcement: { announcementId: 'now', announcementTitle: '2025年半年度业绩预告修正公告',
      announcementTime: Date.parse('2025-07-11T00:00:00+08:00') } },
  ] })
  assert.ok(result.reasons.includes('EARLIER_EARNINGS_DISCLOSURE_IN_ORIGINALS'))
  assert.ok(result.reasons.includes('FIRST_FORECAST_ORIGINAL_NOT_MATCHED'))
})

test('PDF range hyphens are not mistaken for negative bounds, but signs remain unverified', () => {
  const event = auditForecasts([row()]).events[0]
  const source = { completeWithinScope: true, documents: [{
    announcement: { announcementId: 'range', announcementTitle: '2025年半年度业绩预告',
      announcementTime: Date.parse('2025-07-11T00:00:00+08:00') },
    pdf: { sha256: 'a'.repeat(64), url: 'https://static.cninfo.com.cn/test.pdf' },
  }] }
  for (const excerpt of ['盈利：10,000万元-12,000万元', '亏损：10,000万元至12,000万元']) {
    const actual = inspectOriginal(event, source, { range: `${'正文'.repeat(60)}${excerpt}` })
    assert.equal(actual.original.numericTokenMatch, true)
    assert.equal(actual.original.numericMatchIsSemanticProof, false)
    assert.equal(actual.productionEligible, false)
  }
})

test('annual or post-event predictions cannot become historical half-year consensus', () => {
  const event = auditForecasts([row()]).events[0]
  const base = { ts_code: '600000.SH', org_name: 'institution-a', report_date: '20250710', np: 10000 }
  const actual = inspectExpectations(event, [
    { ...base, quarter: '2025Q4' },
    { ...base, quarter: '2025Q2' },
    { ...base, quarter: '2025Q2', report_date: '20250711' },
  ])
  assert.equal(actual.samePeriodRows, 1)
  assert.equal(actual.invalidRows, 1)
  assert.equal(actual.latestInstitutionCount, 1)
  assert.equal(actual.consensus, null)
  assert.ok(actual.reasons.includes('PREDICTION_VERSION_TIME_MISSING'))
})
