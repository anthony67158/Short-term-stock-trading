function bjDayKey(now = Date.now()) {
  const date = new Date(Number(now) + 8 * 3600 * 1000)
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

export function isCurrentDailyReportSummary(summary, now = Date.now()) {
  return Boolean(
    summary
    && typeof summary === 'object'
    && summary.day === bjDayKey(now)
    && String(summary.text || '').trim(),
  )
}

export function attachAdviceDailyReport(
  payload,
  summary,
  now = Date.now(),
) {
  const result = { ...(payload || {}) }
  if (isCurrentDailyReportSummary(summary, now)) {
    result.dailyReport = summary
  }
  return result
}

function resultSummary(result, summarize) {
  if (!result || result.ok === false) return null
  if (result.summary && typeof result.summary === 'object') {
    return result.summary
  }
  return typeof summarize === 'function' ? summarize(result) : null
}

export function createAdviceDailyReportGate({
  now = () => Date.now(),
  summarize = null,
} = {}) {
  let ready = null
  let inFlight = null

  const ensure = async ({
    existingSummary = null,
    getSummary,
    generate,
  } = {}) => {
    const timestamp = now()
    if (isCurrentDailyReportSummary(existingSummary, timestamp)) {
      ready = existingSummary
      return {
        ok: true,
        generated: false,
        source: 'account',
        summary: existingSummary,
      }
    }
    if (isCurrentDailyReportSummary(ready, timestamp)) {
      return {
        ok: true,
        generated: false,
        source: 'memory',
        summary: ready,
      }
    }
    if (inFlight) return inFlight

    inFlight = (async () => {
      const cached = typeof getSummary === 'function'
        ? await getSummary()
        : null
      if (isCurrentDailyReportSummary(cached, now())) {
        ready = cached
        return {
          ok: true,
          generated: false,
          source: 'storage',
          summary: cached,
        }
      }
      if (typeof generate !== 'function') {
        throw new Error('策略日报不存在且无法自动生成')
      }
      const result = await generate()
      if (!result || result.ok === false) {
        throw new Error(
          String(result?.error || '策略日报生成失败'),
        )
      }
      const summary = resultSummary(result, summarize)
      if (!isCurrentDailyReportSummary(summary, now())) {
        throw new Error('策略日报已返回，但摘要无效')
      }
      ready = summary
      return {
        ok: true,
        generated: true,
        source: 'generated',
        summary,
        report: result,
      }
    })().finally(() => { inFlight = null })

    return inFlight
  }

  return { ensure }
}
