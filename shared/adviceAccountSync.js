export async function ensureAdviceAccountSynced({
  flushLocal,
  retryCloud,
} = {}) {
  try {
    const local = typeof flushLocal === 'function'
      ? await flushLocal()
      : true
    if (local === false) {
      return { ok: false, error: '最新交易账本尚未写入云端' }
    }
    const cloud = typeof retryCloud === 'function'
      ? await retryCloud()
      : true
    if (cloud === false) {
      return { ok: false, error: '最新交易账本尚未在 OSS 确认保存' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: '最新交易账本同步失败，请稍后重试' }
  }
}
