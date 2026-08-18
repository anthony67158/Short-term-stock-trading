export function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const A_SHARE_HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-06',
  '2026-05-01',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
])

export function isTradingDay(date) {
  const weekday = date.getDay()
  return weekday !== 0 && weekday !== 6 && !A_SHARE_HOLIDAYS.has(localDateKey(date))
}

export function beijingDate(timestamp = Date.now()) {
  const date = new Date(timestamp)
  return new Date(date.getTime() + (date.getTimezoneOffset() + 480) * 60000)
}

export function beijingDayKey(timestamp = Date.now()) {
  return localDateKey(beijingDate(timestamp))
}

export function beijingMinutes(timestamp = Date.now()) {
  const date = beijingDate(timestamp)
  return date.getHours() * 60 + date.getMinutes()
}

export function isTradingDayAt(timestamp = Date.now()) {
  return isTradingDay(beijingDate(timestamp))
}

export function isContinuousTrading(timestamp = Date.now()) {
  if (!isTradingDayAt(timestamp)) return false
  const minutes = beijingMinutes(timestamp)
  return (minutes >= 570 && minutes <= 690)
    || (minutes >= 780 && minutes <= 900)
}

export function isStockPickSession(timestamp = Date.now()) {
  if (!isTradingDayAt(timestamp)) return false
  const minutes = beijingMinutes(timestamp)
  return minutes >= 555 && minutes <= 901
}

export function nextTradingDate(timestamp = Date.now()) {
  const current = beijingDate(timestamp)
  current.setHours(0, 0, 0, 0)
  for (let offset = 1; offset <= 14; offset++) {
    const candidate = new Date(current.getTime() + offset * 86400000)
    if (isTradingDay(candidate)) return candidate
  }
  return new Date(current.getTime() + 86400000)
}

export function nextTradingDayLabel(timestamp = Date.now()) {
  const today = beijingDate(timestamp)
  today.setHours(0, 0, 0, 0)
  const next = nextTradingDate(timestamp)
  const diffDays = Math.round((next.getTime() - today.getTime()) / 86400000)
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][next.getDay()]
  const monthDay = `${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
  return diffDays === 1
    ? `明天(${weekday} ${monthDay})`
    : `下一交易日${weekday}(${monthDay})`
}
