function pad(value) {
  return String(value).padStart(2, '0')
}

function sameDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function timeOf(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function adviceRecency(timestamp, now = Date.now()) {
  if (timestamp == null || timestamp === '') return null
  const generatedAt = new Date(timestamp)
  const current = new Date(now)
  if (
    !Number.isFinite(generatedAt.getTime())
    || !Number.isFinite(current.getTime())
  ) {
    return null
  }

  const ageMinutes = Math.max(
    0,
    Math.floor((current.getTime() - generatedAt.getTime()) / 60000),
  )
  if (ageMinutes < 3) return { label: '刚刚', tone: 'fresh' }
  if (ageMinutes < 60) {
    return { label: `${ageMinutes}分钟前`, tone: 'fresh' }
  }
  if (sameDay(generatedAt, current)) {
    return { label: `今天 ${timeOf(generatedAt)}`, tone: 'today' }
  }

  const yesterday = new Date(current)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(generatedAt, yesterday)) {
    return { label: `昨天 ${timeOf(generatedAt)}`, tone: 'older' }
  }
  return {
    label: `${pad(generatedAt.getMonth() + 1)}-${pad(generatedAt.getDate())} ${timeOf(generatedAt)}`,
    tone: 'older',
  }
}
