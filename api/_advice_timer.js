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

export function v2AccuracyTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'v2-accuracy-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true };
}
