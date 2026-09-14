import fs from 'node:fs'
import path from 'node:path'
import { hash, auditForecasts, inspectOriginal, inspectExpectations } from './evidence.mjs'

const root = path.resolve('backtest/cache/earnings-v1')
const specRaw = fs.readFileSync('backtest/earnings/experiment.json')
const spec = JSON.parse(specRaw)
const manifestRaw = fs.readFileSync(path.join(root, 'manifest.json'))
const manifest = JSON.parse(manifestRaw)
if (manifest.configHash !== hash(specRaw)) throw new Error('CONFIG_MISMATCH')
function load(reference) {
  if (!/^[\w.-]+\.json$/.test(reference.file)) throw new Error('INVALID_LOCAL_REFERENCE')
  const raw = fs.readFileSync(path.join(root, reference.file))
  if (hash(raw) !== reference.sha256) throw new Error('REFERENCE_CHECKSUM_MISMATCH')
  return JSON.parse(raw)
}
const counts = values => values.reduce((result, key) => ({ ...result, [key]: (result[key] || 0) + 1 }), {})
const periods = {}, events = new Map()
for (const period of spec.periods) {
  if (!manifest.forecasts[period]) throw new Error('PERIOD_MISSING')
  const rows = load(manifest.forecasts[period])
  const audit = auditForecasts(rows)
  audit.events.forEach(event => events.set(event.key, event))
  periods[period] = {
    rows: rows.length, issuerPeriodGroups: audit.events.length,
    multipleRowGroups: audit.events.filter(event => event.versionRows > 1).length,
    earliestValueDuplicateRows: audit.events.reduce((sum, event) => sum + event.earliestValueDuplicateRows, 0),
    laterValueChangeGroups: audit.events.filter(event => event.laterChangedValueRows > 0).length,
    invalidRows: audit.invalidRows, reasonCounts: counts(audit.events.flatMap(event => event.reasons)),
  }
}
const results = [], allPublications = []
for (const sample of manifest.samples) {
  const key = `${sample.code}:${sample.period}`
  const event = events.get(key)
  if (!event) throw new Error('SAMPLED_EVENT_MISSING')
  if (!manifest.sourceAudits[key]) throw new Error('SOURCE_COLLECTION_NOT_FINISHED')
  const source = load(manifest.sourceAudits[key])
  const textById = {}
  if (source.history) {
    const history = load(source.history)
    allPublications.push(...history.rows)
    if (history.total !== history.rows.length) throw new Error('SOURCE_TOTAL_MISMATCH')
  }
  for (const doc of source.documents || []) {
    if (doc.pdf?.text) {
      const raw = fs.readFileSync(path.join(root, doc.pdf.file))
      if (hash(raw) !== doc.pdf.sha256) throw new Error('PDF_CHECKSUM_MISMATCH')
      textById[doc.announcement.announcementId] = load(doc.pdf.text).text
    }
  }
  results.push({ sample, firstForecast: event, sourceScopeComplete: source.completeWithinScope,
    sourceErrorType: source.errorType || null, ...inspectOriginal(event, source, textById) })
}
const sourceFiles = [
  'backtest/earnings/experiment.json', 'backtest/earnings/collect.py',
  'backtest/earnings/evidence.mjs', 'backtest/earnings/audit.mjs',
]
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(file))]))
const expectationProbes = Object.fromEntries(Object.entries(manifest.expectationProbes || {})
  .map(([key, reference]) => {
    const probe = load(reference)
    return [key, probe.errorType ? { errorType: probe.errorType }
      : inspectExpectations(events.get(key), probe.rows)]
  }))
const report = {
  schemaVersion: 'earnings-event-evidence-audit.v1',
  state: 'BLOCKED_EVIDENCE', productionEligible: false,
  finalEquity: null, returnPct: null, reason: 'No verified surprise dataset; no trades simulated',
  inputManifestHash: hash(manifestRaw), sourceHashes, periods, sampleSize: results.length,
  sampledCompleteIssuerHistories: results.filter(result => result.sourceScopeComplete).length,
  fetchedIssuerAnnouncementRows: allPublications.length,
  relevantDocuments: results.reduce((sum, result) => sum + result.documents.length, 0),
  readableDocuments: results.reduce((sum, result) =>
    sum + result.documents.filter(doc => doc.originalTextAvailable).length, 0),
  firstDateSingleOriginalMatches: results.filter(result => result.original).length,
  matchedOriginalNumericTokens: results.filter(result => result.original?.numericTokenMatch).length,
  sourceTimestampPrecisions: counts(results.flatMap(result => result.documents.map(doc => doc.precision))),
  reasonCounts: counts(results.flatMap(result => result.reasons)),
  directReturnEligible: 0, results, expectationProbes,
  limitations: [
    'The bulk provider gives rows but no total count or guarantee of full version history.',
    'Issuer source history begins in January of the reporting year, not inception.',
    'Sampling is deterministic, conditional on main-board positive forecast lower profit; it is not a market representative performance study.',
    'PDF numeric tokens do not establish table identity, consolidated scope, units or exact disclosure time.',
    'Limited seller forecasts are probed, but original research/version provenance and an accepted pre-event baseline remain missing.',
    'Forecast growth is not market surprise; a data gate does not measure strategy profitability.',
  ],
}
const output = path.resolve('backtest/reports/earnings-v1')
fs.mkdirSync(output, { recursive: true })
const raw = JSON.stringify(report, null, 2) + '\n'
const file = path.join(output, `audit-${hash(raw)}.json`)
if (!fs.existsSync(file)) fs.writeFileSync(file, raw)
console.log(JSON.stringify({ state: report.state, periods, samples: report.sampleSize,
  complete: report.sampledCompleteIssuerHistories, documents: report.relevantDocuments,
  readable: report.readableDocuments, firstDateMatches: report.firstDateSingleOriginalMatches,
  numericTokenMatches: report.matchedOriginalNumericTokens, reasons: report.reasonCounts,
  expectationProbes, output: file }, null, 2))
process.exitCode = 2
