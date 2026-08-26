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

export function quantInputReadiness(version, candles) {
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
  return {
    ready: false,
    source: 'daily',
    reason: 'INSUFFICIENT_DAILY_CANDLES',
  }
}
