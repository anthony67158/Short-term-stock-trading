export function shouldApplyCloudBatch(progress) {
  return !!(
    progress &&
    typeof progress === 'object' &&
    Number(progress.total) > 0 &&
    Array.isArray(progress.items) &&
    progress.items.length > 0
  )
}

export function adviceJobState(batch, code) {
  if (!batch || !code) return null
  const item = (batch.items || []).find((entry) => String(entry?.code) === String(code))
  if (!item || !['queued', 'pending', 'running', 'canceling'].includes(item.status)) return null
  const running = item.status === 'running'
  const canceling = item.status === 'canceling'
  return {
    active: true,
    status: item.status,
    label: canceling ? '正在取消生成' : (item.phase || (running ? 'AI 操作建议生成中' : '排队等待云端生成')),
    cancelable: !canceling,
    cloud: !!batch.serverMode,
  }
}
