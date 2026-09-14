import { createHash } from 'node:crypto'

export const hash = value => createHash('sha256').update(value).digest('hex')
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return false
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
  const time = Date.parse(`${iso}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === iso
}
const finite = value => typeof value === 'number' && Number.isFinite(value)
const financialFields = ['net_profit_min', 'net_profit_max', 'last_parent_net', 'p_change_min', 'p_change_max', 'type']
const financialKey = row => JSON.stringify(financialFields.map(key => row[key] ?? null))

export function auditForecasts(rows) {
  const groups = new Map(), invalidRows = []
  rows.forEach((row, index) => {
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(row.ts_code || '')
        || !validDate(row.ann_date) || !validDate(row.end_date)) {
      invalidRows.push(index)
      return
    }
    const key = `${row.ts_code}:${row.end_date}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  })
  const events = []
  for (const [key, versions] of groups) {
    const sorted = [...versions].sort((a, b) => a.ann_date.localeCompare(b.ann_date))
    const firstDate = sorted[0].ann_date
    const sameDate = sorted.filter(row => row.ann_date === firstDate)
    const first = sameDate[0], reasons = []
    if (new Set(sameDate.map(financialKey)).size !== 1) reasons.push('FIRST_DATE_VALUE_CONFLICT')
    if (!sameDate.every(row => validDate(row.first_ann_date))) reasons.push('FIRST_ANNOUNCEMENT_DATE_MISSING')
    if (sameDate.some(row => validDate(row.first_ann_date) && row.first_ann_date < firstDate)) {
      reasons.push('EARLIER_FIRST_ANNOUNCEMENT_NOT_IN_ROWS')
    }
    if (sameDate.some(row => validDate(row.first_ann_date) && row.first_ann_date > firstDate)) {
      reasons.push('FIRST_ANNOUNCEMENT_AFTER_CURRENT_DATE')
    }
    if (!finite(first.net_profit_min) || !finite(first.net_profit_max)) reasons.push('PROFIT_RANGE_MISSING')
    else if (first.net_profit_min > first.net_profit_max) reasons.push('PROFIT_RANGE_REVERSED')
    const earliestKey = financialKey(first)
    events.push({
      key, code: first.ts_code, period: first.end_date, annDate: firstDate,
      declaredFirstAnnDate: first.first_ann_date,
      versionRows: sorted.length,
      distinctDates: new Set(sorted.map(row => row.ann_date)).size,
      earliestValueDuplicateRows: sameDate.length - new Set(sameDate.map(financialKey)).size,
      laterChangedValueRows: sorted.filter(row => row.ann_date > firstDate && financialKey(row) !== earliestKey).length,
      reasons, firstRow: first,
      forecastRangeCny: finite(first.net_profit_min) && finite(first.net_profit_max)
        ? [first.net_profit_min * 10000, first.net_profit_max * 10000] : null,
      marketSurprise: null,
      productionEligible: false,
    })
  }
  return { events, invalidRows }
}

export function sourceCalendarDate(timestamp) {
  if (!finite(timestamp) || timestamp <= 0) return null
  const time = new Date(timestamp + 8 * 3600000)
  if (!Number.isFinite(time.getTime())) return null
  return time.toISOString().slice(0, 10).replaceAll('-', '')
}

export function nextSessionAfterDisclosure(date, calendar) {
  if (!validDate(date)) throw new Error('INVALID_DISCLOSURE_DATE')
  return calendar.find(day => day > date) || null
}

export function inspectOriginal(event, sourceAudit, textById = {}) {
  const reasons = [...event.reasons]
  if (!sourceAudit?.completeWithinScope) reasons.push('ISSUER_HISTORY_INCOMPLETE')
  const documents = (sourceAudit?.documents || []).map(doc => {
    const title = doc.announcement?.announcementTitle || ''
    const date = sourceCalendarDate(doc.announcement?.announcementTime)
    const text = textById[doc.announcement?.announcementId] || ''
    // A hyphen may separate a range ("8300万元-9500万元"); this checks magnitudes only.
    const numbers = new Set((text.replace(/[,，]/g, '').match(/\d+(?:\.\d+)?/g) || [])
      .map(Number).filter(Number.isFinite))
    const requested = event.forecastRangeCny?.map(amount => amount / 10000) || []
    const numericTokenMatch = requested.length === 2 && requested.every(number => numbers.has(Math.abs(number)))
    return { id: doc.announcement?.announcementId, title, date,
      url: doc.pdf?.url || null, pdfSha256: doc.pdf?.sha256 || null,
      originalTextAvailable: text.trim().length > 100,
      numericTokenMatch, numericTokenMeaning: 'ABSOLUTE_MAGNITUDE_ONLY', numericMatchIsSemanticProof: false,
      correction: /修正|更正|补充|取消|撤回/.test(title),
      precision: date && doc.announcement.announcementTime % 86400000 === 57600000 ? 'DATE_ONLY' : 'SOURCE_TIMESTAMP',
    }
  }).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
  const sameDay = documents.filter(doc => doc.date === event.annDate && !doc.correction)
  if (!sameDay.length) reasons.push('FIRST_FORECAST_ORIGINAL_NOT_MATCHED')
  else if (sameDay.length > 1) reasons.push('MULTIPLE_SAME_DAY_ORIGINALS')
  const original = sameDay.length === 1 ? sameDay[0] : null
  if (!original?.originalTextAvailable) reasons.push('ORIGINAL_TEXT_UNAVAILABLE')
  if (documents.some(doc => doc.date && doc.date < event.annDate && !doc.correction)) {
    reasons.push('EARLIER_EARNINGS_DISCLOSURE_IN_ORIGINALS')
  }
  if (original?.originalTextAvailable && !original.numericTokenMatch) reasons.push('FORECAST_NUMBERS_NOT_FOUND_AS_TOKENS')
  // Finding two numbers in a document cannot establish the correct table, period, units or scope.
  reasons.push('ORIGINAL_PROFIT_TABLE_NOT_SEMANTICALLY_VERIFIED')
  reasons.push('POINT_IN_TIME_EXPECTATION_MISSING')
  reasons.push('FULL_EARLIER_DISCLOSURE_CHAIN_NOT_CERTIFIED')
  return { key: event.key, original, documents, reasons: [...new Set(reasons)],
    earliestTradePolicy: 'NEXT_SESSION_AFTER_VERIFIED_SOURCE_DATE',
    earningsSurprise: null, expectedReturn: null, productionEligible: false,
    state: 'BLOCKED_EVIDENCE' }
}

export function inspectExpectations(event, rows) {
  const quarter = `${event.period.slice(0, 4)}Q${Number(event.period.slice(4, 6)) / 3}`
  const invalidReasons = rows.flatMap(row => [
    ...(row.ts_code !== event.code ? ['WRONG_SECURITY'] : []),
    ...(!validDate(row.report_date) ? ['INVALID_REPORT_DATE']
      : row.report_date >= event.annDate ? ['NOT_BEFORE_EVENT'] : []),
    ...(!finite(row.np) ? ['NET_PROFIT_MISSING_OR_INVALID'] : []),
  ])
  const invalid = rows.filter(row => row.ts_code !== event.code || !validDate(row.report_date)
    || row.report_date >= event.annDate || !finite(row.np))
  const samePeriod = rows.filter(row => !invalid.includes(row) && row.quarter === quarter)
  const latestByInstitution = new Map()
  for (const row of samePeriod) {
    if (!row.org_name) continue
    const previous = latestByInstitution.get(row.org_name)
    if (!previous || row.report_date > previous.report_date) latestByInstitution.set(row.org_name, row)
  }
  const reasons = []
  if (invalid.length) reasons.push('INVALID_OR_POST_EVENT_PREDICTIONS')
  if (!samePeriod.length) reasons.push('MATCHING_PERIOD_PREDICTION_MISSING')
  if (samePeriod.some(row => !row.create_time)) reasons.push('PREDICTION_VERSION_TIME_MISSING')
  if (latestByInstitution.size < 3) reasons.push('FEWER_THAN_THREE_INDEPENDENT_INSTITUTIONS')
  reasons.push('ORIGINAL_RESEARCH_REPORTS_AND_REVISION_HISTORY_NOT_VERIFIED')
  return {
    requestedQuarter: quarter, rows: rows.length, invalidRows: invalid.length,
    invalidReasonCounts: invalidReasons.reduce((counts, reason) => {
      counts[reason] = (counts[reason] || 0) + 1
      return counts
    }, {}),
    samePeriodRows: samePeriod.length, latestInstitutionCount: latestByInstitution.size,
    versionTimeRows: samePeriod.filter(row => row.create_time).length,
    quarterCounts: rows.reduce((counts, row) => {
      const key = String(row.quarter || 'MISSING')
      counts[key] = (counts[key] || 0) + 1
      return counts
    }, {}),
    reasons, consensus: null, earningsSurprise: null, productionEligible: false,
  }
}
