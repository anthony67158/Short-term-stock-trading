export function adviceTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'advice-resume-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { resumeOnly: true, autoRefresh: true };
}

export function adviceWorkerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.source !== 'stock-dashboard.advice-worker') return null;
  if (String(event.key || '') !== String(cronKey)) return null;
  const nick = String(event.nick || '').trim();
  if (!nick) return null;
  return { resumeOnly: true, worker: true, nick };
}

export function dailyReportWorkerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.source !== 'stock-dashboard.daily-report-worker') return null;
  if (String(event.key || '') !== String(cronKey)) return null;
  const nick = String(event.nick || '').trim();
  const session = String(event.session || '').trim();
  const runKey = String(event.runKey || '').trim();
  if (
    !nick
    || !['morning', 'noon', 'evening'].includes(session)
    || !/^\d{4}-\d{2}-\d{2}:(morning|noon|evening)$/.test(runKey)
    || !runKey.endsWith(`:${session}`)
  ) return null;
  return {
    dailyReportWorker: true,
    nick,
    session,
    runKey,
  };
}

export function dailyReportTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'daily-report-schedule-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true };
}

export function portfolioAnalysisWorkerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (
    event.source
    !== 'stock-dashboard.portfolio-analysis-worker'
  ) return null;
  if (String(event.key || '') !== String(cronKey)) return null;
  const nick = String(event.nick || '').trim();
  const jobId = String(event.jobId || '').trim();
  if (!nick || !/^portfolio_\d+$/.test(jobId)) return null;
  return { op: 'worker', nick, jobId };
}

export function portfolioAnalysisTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (
    event.triggerName !== 'portfolio-analysis-resume-timer'
  ) return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { op: 'resume' };
}

export function v2AccuracyTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'v2-accuracy-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true };
}

export function opportunityRadarTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (
    event.triggerName !== 'opportunity-radar-settlement-timer'
  ) return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true };
}

export function sectorForecastTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'sector-forecast-due-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { action: 'run_due' };
}

export function tailPickTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'tail-pick-1450-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true };
}

export function tailPickWorkerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.source !== 'stock-dashboard.tail-pick-worker') return null;
  if (String(event.key || '') !== String(cronKey)) return null;
  if (event.mode !== 'manual') return null;
  return { worker: true, mode: 'manual' };
}

export function formulaSelectionTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'formula-selection-close-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true, mode: 'close' };
}

const REVIEW_TIMER_SESSIONS = new Map([
  ['review-noon-open', 'noon'],
  ['review-noon-core', 'noon'],
  ['review-close-open', 'close'],
  ['review-close-late', 'close'],
]);

export function reviewTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  const session = REVIEW_TIMER_SESSIONS.get(String(event.triggerName || ''));
  if (!session) return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true, session };
}

const ALERT_TIMER_NAMES = new Set([
  'alert-market-am-open',
  'alert-market-am-core',
  'alert-market-am-close',
  'alert-market-pm-core',
  'alert-market-pm-close',
]);

export function alertTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (!ALERT_TIMER_NAMES.has(String(event.triggerName || ''))) return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true, roundMs: 8000, budgetMs: 50000 };
}
