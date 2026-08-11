export function adviceTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'advice-resume-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { resumeOnly: true, autoRefresh: true };
}

export function v2AccuracyTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'v2-accuracy-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { scheduled: true };
}
