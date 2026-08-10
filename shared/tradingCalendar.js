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
