export function adviceTimerBody(event, cronKey) {
  if (!cronKey || !event || typeof event !== 'object') return null;
  if (event.triggerName !== 'advice-resume-timer') return null;
  if (String(event.payload || '') !== String(cronKey)) return null;
  return { resumeOnly: true };
}
