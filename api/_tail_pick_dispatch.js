import { dispatchFcEvent } from './_advice_dispatch.js'

const WORKER_SOURCE = 'stock-dashboard.tail-pick-worker'

export function buildTailPickWorkerEvent(mode, cronKey) {
  const runMode = String(mode || '')
  if (runMode !== 'manual') throw new Error('尾盘Worker模式无效')
  const key = String(cronKey || '')
  if (!key) throw new Error('内部调度密钥未配置')
  return {
    source: WORKER_SOURCE,
    key,
    mode: runMode,
  }
}

export function dispatchTailPickWorker(mode, options = {}) {
  const env = options.env || process.env
  return dispatchFcEvent(
    buildTailPickWorkerEvent(mode, env.CRON_KEY),
    options,
  )
}
