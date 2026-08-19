import {
  beijingDate,
  beijingDayKey,
  beijingMinutes,
  isTradingDay,
} from './tradingCalendar.js'

function dateKey(value) {
  const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function dateFromKey(value) {
  const key = dateKey(value)
  if (!key) return null
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  return Number.isFinite(date.getTime()) ? date : null
}

function nextTradingDayAfter(value) {
  const signalDate = dateFromKey(value)
  if (!signalDate) return ''
  for (let offset = 1; offset <= 14; offset++) {
    const candidate = new Date(signalDate)
    candidate.setDate(candidate.getDate() + offset)
    if (isTradingDay(candidate)) {
      const year = candidate.getFullYear()
      const month = String(candidate.getMonth() + 1).padStart(2, '0')
      const day = String(candidate.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
  }
  return ''
}

export function shouldRefreshProductionForecast({
  asOf,
  latestCandleDate,
  now = Date.now(),
} = {}) {
  const signalDate = dateKey(asOf)
  const candleDate = dateKey(latestCandleDate)
  if (!signalDate || !candleDate || candleDate <= signalDate) return false
  const today = beijingDayKey(now)
  if (candleDate < today) return true
  const currentDate = beijingDate(now)
  const minutes = beijingMinutes(now)
  return (
    candleDate === today
    && isTradingDay(currentDate)
    && (minutes > 900 || (minutes === 900 && currentDate.getSeconds() > 0))
  )
}

export function productionForecastWindow({
  asOf,
  targetDate: requestedTargetDate,
  latestCandleDate,
  now = Date.now(),
} = {}) {
  const signalDate = dateKey(asOf)
  const today = beijingDayKey(now)
  const currentDate = beijingDate(now)
  const targetDate = dateKey(requestedTargetDate)
    || nextTradingDayAfter(signalDate)
  const minutes = beijingMinutes(now)
  const targetsToday = (
    !!signalDate
    && targetDate === today
    && isTradingDay(currentDate)
  )

  if (targetsToday && minutes < 570) {
    return {
      kind: 'today',
      label: '今日预测',
      shortLabel: '今日',
      signalDate,
      targetDate,
      isTodayTarget: true,
      note: `基于 ${signalDate} 收盘日线，预测今日完整交易日`,
    }
  }
  if (targetsToday && minutes <= 900) {
    return {
      kind: 'today-full-session',
      label: '今日整日预测',
      shortLabel: '今日整日',
      signalDate,
      targetDate,
      isTodayTarget: true,
      note: `基于 ${signalDate} 收盘日线预测今日整日，不是当前时点到收盘的剩余时段预测`,
    }
  }
  if (targetsToday) {
    if (shouldRefreshProductionForecast({
      asOf,
      latestCandleDate,
      now,
    })) {
      return {
        kind: 'stale-result',
        label: '旧预测已过期',
        shortLabel: '旧预测',
        signalDate,
        targetDate,
        isTodayTarget: true,
        needsRefresh: true,
        note: `今日收盘K线已更新至 ${dateKey(latestCandleDate)}，正在刷新下一交易日预测`,
      }
    }
    return {
      kind: 'stale-session',
      label: '最近交易日预测',
      shortLabel: '最近交易日',
      signalDate,
      targetDate,
      isTodayTarget: true,
      note: '今日交易已结束，等待今日收盘K线更新后生成下一交易日预测',
    }
  }
  return {
    kind: 'next-trading-day',
    label: '下一交易日预测',
    shortLabel: '下一交易日',
    signalDate,
    targetDate,
    isTodayTarget: false,
    note: '生产日线模型预测下一交易日，不提供今日剩余时段概率',
  }
}

export function selectPrimaryProductionForecast({
  currentTradingDayForecast,
  nextTradeDayForecast,
  nextSignalAsOf,
  latestCandleDate,
  now = Date.now(),
} = {}) {
  const currentWindow = currentTradingDayForecast
    ? productionForecastWindow({
        asOf: currentTradingDayForecast.sourceAsOf,
        targetDate: currentTradingDayForecast.targetDate,
        latestCandleDate,
        now,
      })
    : null
  const useCurrent = (
    currentWindow?.isTodayTarget === true
    && currentWindow?.needsRefresh !== true
  )
  const forecast = useCurrent
    ? currentTradingDayForecast
    : nextTradeDayForecast || null
  const window = useCurrent
    ? currentWindow
    : (nextTradeDayForecast
      ? productionForecastWindow({
          asOf: nextSignalAsOf,
          targetDate: nextTradeDayForecast.targetDate,
          latestCandleDate,
          now,
        })
      : currentWindow)
  return {
    forecast,
    window,
    currentWindow,
  }
}
