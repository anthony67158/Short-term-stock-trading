import {
  normalizeQuantModelVersion,
  QUANT_MODEL_DEFAULT,
} from './modelVersion.js'

function validCandles(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) =>
      item?.date
      && Number.isFinite(Number(item.open))
      && Number.isFinite(Number(item.high))
      && Number.isFinite(Number(item.low))
      && Number.isFinite(Number(item.close))
      && Number.isFinite(Number(item.volume))
    )
}

function completedMinuteCutoff(context = {}) {
  if (!context.tradingToday || !context.isLive) return ''
  const match = String(context.bjNow || '').match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/,
  )
  if (!match) return ''
  const total = Number(match[2]) * 60 + Number(match[3])
  const completed = Math.floor((total - 1) / 5) * 5
  return `${match[1]} ${String(Math.floor(completed / 60)).padStart(2, '0')}:${String(completed % 60).padStart(2, '0')}:00`
}

export function backfillDailyCandlesFromMinuteBars(
  dailyCandles,
  minuteBars,
  context = {},
) {
  const cutoff = completedMinuteCutoff(context)
  const groups = new Map()
  for (const bar of Array.isArray(minuteBars) ? minuteBars : []) {
    const tradeTime = String(bar?.tradeTime || '')
    if (
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tradeTime)
      || cutoff && tradeTime > cutoff
      || !Number.isFinite(Number(bar.open))
      || !Number.isFinite(Number(bar.high))
      || !Number.isFinite(Number(bar.low))
      || !Number.isFinite(Number(bar.close))
      || !Number.isFinite(Number(bar.volume))
    ) continue
    const date = tradeTime.slice(0, 10)
    const session = groups.get(date) || []
    session.push(bar)
    groups.set(date, session)
  }
  const minuteDaily = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, session]) => {
      const ordered = [...session].sort((left, right) =>
        String(left.tradeTime).localeCompare(String(right.tradeTime)),
      )
      return {
        date,
        open: Number(ordered[0].open),
        high: Math.max(...ordered.map((bar) => Number(bar.high))),
        low: Math.min(...ordered.map((bar) => Number(bar.low))),
        close: Number(ordered.at(-1).close),
        volume: ordered.reduce(
          (sum, bar) => sum + Number(bar.volume),
          0,
        ),
        pct: 0,
      }
    })
  const merged = new Map(
    validCandles(dailyCandles).map((item) => [
      String(item.date),
      { ...item },
    ]),
  )
  for (const item of minuteDaily) merged.set(item.date, item)
  const candles = [...merged.values()]
    .sort((left, right) =>
      String(left.date).localeCompare(String(right.date)),
    )
    .slice(-120)
  for (let index = 1; index < candles.length; index++) {
    const previous = Number(candles[index - 1].close)
    candles[index].pct = previous > 0
      ? +((Number(candles[index].close) / previous - 1) * 100)
        .toFixed(2)
      : 0
  }
  return {
    candles,
    inputAsOf: String(
      (Array.isArray(minuteBars) ? minuteBars : [])
        .filter((bar) =>
          bar?.tradeTime
          && (!cutoff || String(bar.tradeTime) <= cutoff),
        )
        .sort((left, right) =>
          String(left.tradeTime).localeCompare(
            String(right.tradeTime),
          ),
        )
        .at(-1)?.tradeTime
      || candles.at(-1)?.date
      || '',
    ),
    inputSource: minuteDaily.length
      ? 'completed-5m-daily-backfill'
      : 'daily-kline',
    inputBarCount: (Array.isArray(minuteBars) ? minuteBars : [])
      .filter((bar) =>
        bar?.tradeTime
        && (!cutoff || String(bar.tradeTime) <= cutoff),
      ).length,
  }
}

export function selectFreshestDailyDetail(
  primary,
  backup,
  { computeTechnicals } = {},
) {
  const primaryCandles = validCandles(primary?.candles)
  const backupCandles = validCandles(backup?.candles)
  const primaryDate = String(primaryCandles.at(-1)?.date || '')
  const backupDate = String(backupCandles.at(-1)?.date || '')
  const useBackup = (
    backupDate > primaryDate
    || (
      backupDate === primaryDate
      && backupCandles.length > primaryCandles.length
    )
  )
  const candles = useBackup ? backupCandles : primaryCandles
  if (!candles.length) {
    return primary && typeof primary === 'object'
      ? primary
      : { ok: false, candles: [] }
  }
  const source = useBackup ? 'tencent-daily' : 'stock-detail'
  const shouldRecompute = useBackup || !primary?.tech
  let tech = primary?.tech || null
  if (shouldRecompute && typeof computeTechnicals === 'function') {
    try {
      tech = computeTechnicals(candles, '日')
    } catch {
      tech = null
    }
  }
  return {
    ...(primary && typeof primary === 'object' ? primary : {}),
    ok: true,
    profile: primary?.profile || {
      name: String(backup?.name || ''),
    },
    candles,
    tech,
    dailySource: source,
    dailyAsOf: String(candles.at(-1)?.date || ''),
  }
}

export function quantInputReadiness(
  version,
  candles,
  { allowMinuteBackfill = false } = {},
) {
  const selected = normalizeQuantModelVersion(version)
  if (selected !== QUANT_MODEL_DEFAULT) {
    return {
      ready: true,
      source: 'minute',
      reason: '',
    }
  }
  if (validCandles(candles).length >= 25) {
    return {
      ready: true,
      source: 'daily',
      reason: '',
    }
  }
  if (allowMinuteBackfill) {
    return {
      ready: true,
      source: 'minute-backfill',
      reason: '',
    }
  }
  return {
    ready: false,
    source: 'daily',
    reason: 'INSUFFICIENT_DAILY_CANDLES',
  }
}
