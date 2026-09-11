export const BATCH_COMPLETION_VISIBLE_MS = 8000

export function batchProgressVisibility(batch = {}, now = Date.now()) {
  if (batch.running) {
    return {
      visible: true,
      hideAfterMs: null,
    }
  }
  if (!(Number(batch.total) > 0)) {
    return {
      visible: false,
      hideAfterMs: null,
    }
  }
  const finishedAt = Number(batch.finishedAt || batch.at)
  if (!(finishedAt > 0)) {
    return {
      visible: false,
      hideAfterMs: null,
    }
  }
  const ageMs = Math.max(0, Number(now) - finishedAt)
  const hideAfterMs = Math.max(
    0,
    BATCH_COMPLETION_VISIBLE_MS - ageMs,
  )
  return {
    visible: hideAfterMs > 0,
    hideAfterMs: hideAfterMs > 0 ? hideAfterMs : null,
  }
}
