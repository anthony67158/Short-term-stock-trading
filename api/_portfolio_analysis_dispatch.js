import { dispatchFcEvent } from './_advice_dispatch.js'

const WORKER_SOURCE = 'stock-dashboard.portfolio-analysis-worker'

export function buildPortfolioAnalysisWorkerEvent(
  nick,
  jobId,
  cronKey,
) {
  const accountNick = String(nick || '').trim()
  const id = String(jobId || '').trim()
  const key = String(cronKey || '')
  if (!accountNick) throw new Error('缺少持仓分析账号')
  if (!/^portfolio_\d+$/.test(id)) {
    throw new Error('持仓分析任务ID无效')
  }
  if (!key) throw new Error('内部调度密钥未配置')
  return {
    source: WORKER_SOURCE,
    key,
    nick: accountNick,
    jobId: id,
  }
}

export function dispatchPortfolioAnalysisWorker(
  nick,
  jobId,
  options = {},
) {
  const env = options.env || process.env
  return dispatchFcEvent(
    buildPortfolioAnalysisWorkerEvent(
      nick,
      jobId,
      env.CRON_KEY,
    ),
    options,
  )
}
