import { readJson } from './_blob.js'

export const PRODUCTION_ACCURACY_KEY =
  'quantmodel/production_accuracy.json'

function count(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.round(numeric)
    : 0
}

function optionalNumber(value, minimum = 0, maximum = 100) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
    ? +numeric.toFixed(1)
    : null
}

function accuracy(correct, total) {
  return total > 0 ? +(correct / total * 100).toFixed(1) : null
}

function emptyProductionAccuracy() {
  return {
    available: false,
    mode: 'forwardUnseenBacktest',
    updatedAt: 0,
    model: {
      trainedAt: 0,
      dataEndDate: '',
      horizonDays: 5,
      featureCount: 0,
    },
    overall: {
      total: 0,
      correct: 0,
      accuracyPct: null,
      balancedAccuracyPct: null,
    },
    strongSignals: {
      total: 0,
      correct: 0,
      accuracyPct: null,
      coveragePct: null,
      positiveThresholdPct: 62,
      negativeThresholdPct: 38,
    },
    nextTradeDayDirection: {
      total: 0,
      correct: 0,
      accuracyPct: null,
    },
    nextTradeDayRange: {
      total: 0,
      covered: 0,
      coveragePct: null,
      nominalCoveragePct: 80,
    },
    days: [],
    sampleWindow: {
      from: '',
      to: '',
      tradingDates: 0,
    },
  }
}

export function normalizeProductionAccuracy(payload) {
  if (
    payload?.schemaVersion !== 'production-accuracy.v1'
    && !payload?.overall
  ) {
    return emptyProductionAccuracy()
  }
  const total = count(payload?.overall?.total)
  const correct = Math.min(total, count(payload?.overall?.correct))
  const strongTotal = Math.min(total, count(payload?.strongSignals?.total))
  const strongCorrect = Math.min(
    strongTotal,
    count(payload?.strongSignals?.correct),
  )
  const directionTotal = Math.min(
    total,
    count(payload?.nextTradeDayDirection?.total),
  )
  const directionCorrect = Math.min(
    directionTotal,
    count(payload?.nextTradeDayDirection?.correct),
  )
  const rangeTotal = Math.min(
    total,
    count(payload?.nextTradeDayRange?.total),
  )
  const rangeCovered = Math.min(
    rangeTotal,
    count(payload?.nextTradeDayRange?.covered),
  )
  const days = (Array.isArray(payload?.days) ? payload.days : [])
    .map((item) => {
      const dayTotal = count(item?.total)
      const dayCorrect = Math.min(dayTotal, count(item?.correct))
      return {
        date: String(item?.date || '').slice(0, 10),
        total: dayTotal,
        correct: dayCorrect,
        accuracyPct: accuracy(dayCorrect, dayTotal),
      }
    })
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.total > 0)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 30)
  return {
    available: total > 0,
    mode: 'forwardUnseenBacktest',
    updatedAt: count(payload?.updatedAt),
    model: {
      trainedAt: count(payload?.model?.trainedAt),
      dataEndDate: String(payload?.model?.dataEndDate || '').slice(0, 10),
      horizonDays: count(payload?.model?.horizonDays) || 5,
      featureCount: count(payload?.model?.featureCount),
    },
    overall: {
      total,
      correct,
      accuracyPct: accuracy(correct, total),
      balancedAccuracyPct: optionalNumber(
        payload?.overall?.balancedAccuracyPct,
      ),
    },
    strongSignals: {
      total: strongTotal,
      correct: strongCorrect,
      accuracyPct: accuracy(strongCorrect, strongTotal),
      coveragePct: total > 0 ? +(strongTotal / total * 100).toFixed(1) : null,
      positiveThresholdPct:
        optionalNumber(payload?.strongSignals?.positiveThresholdPct) ?? 62,
      negativeThresholdPct:
        optionalNumber(payload?.strongSignals?.negativeThresholdPct) ?? 38,
    },
    nextTradeDayDirection: {
      total: directionTotal,
      correct: directionCorrect,
      accuracyPct: accuracy(directionCorrect, directionTotal),
    },
    nextTradeDayRange: {
      total: rangeTotal,
      covered: rangeCovered,
      coveragePct: accuracy(rangeCovered, rangeTotal),
      nominalCoveragePct:
        optionalNumber(payload?.nextTradeDayRange?.nominalCoveragePct) ?? 80,
    },
    days,
    sampleWindow: {
      from: String(payload?.sampleWindow?.from || '').slice(0, 10),
      to: String(payload?.sampleWindow?.to || '').slice(0, 10),
      tradingDates: count(payload?.sampleWindow?.tradingDates),
    },
  }
}

export async function loadProductionAccuracy({
  read = readJson,
} = {}) {
  return normalizeProductionAccuracy(
    await read(PRODUCTION_ACCURACY_KEY),
  )
}
