import { applyCors, preflight } from './_lib.js'
import {
  isAccountActive,
  listAllAccounts,
  readAccount,
  writeAccount,
} from './account.js'
import { isAuthorizedAccount } from './_account_auth.js'
import { dispatchDailyReportWorker } from './_advice_dispatch.js'
import { invokeSSE } from './cron_advice.js'
import dailyReportHandler from './daily_report.js'
import {
  claimDueDailyReport,
  completeDailyReportRun,
  failDailyReportRun,
} from '../shared/dailyReportSchedule.js'

function reportStocks(data = {}) {
  const holdings = (data.holding || [])
    .filter((item) => item?.code)
    .map((item) => ({
      code: String(item.code),
      name: String(item.name || item.code),
      industry: String(item.industry || ''),
      concept: String(item.concept || ''),
    }))
  const held = new Set(holdings.map((item) => item.code))
  const watchlist = (data.plan || [])
    .filter((item) => item?.code && !held.has(String(item.code)))
    .sort((left, right) => Number(right?.star) - Number(left?.star))
    .map((item) => ({
      code: String(item.code),
      name: String(item.name || item.code),
      industry: String(item.industry || ''),
      concept: String(item.concept || ''),
      star: item.star === true,
    }))
  return { holdings, watchlist }
}

async function generateReport(task, account) {
  const stocks = reportStocks(account?.data)
  return invokeSSE(dailyReportHandler, {
    method: 'POST',
    query: { session: task.session },
    body: {
      accountNick: task.nick,
      ...stocks,
    },
    timeoutMs: 145000,
    trustedAccount: true,
  })
}

async function defaultWrite(account) {
  return writeAccount(account, undefined, {
    history: false,
    verify: true,
  })
}

export async function processDailyReportAccount(
  task,
  dependencies = {},
) {
  const read = dependencies.read || readAccount
  const write = dependencies.write || defaultWrite
  const generate = dependencies.generate || generateReport
  const now = dependencies.now || Date.now
  const account = await read(task.nick)
  if (!isAccountActive(account)) {
    return { ok: false, skipped: 'inactive-account' }
  }
  const active = account.data?.dailyReportAuto?.active
  if (
    !active
    || active.runKey !== task.runKey
    || active.session !== task.session
  ) {
    return { ok: false, skipped: 'stale-task' }
  }

  let response = null
  try {
    response = await generate({
      ...task,
      ...reportStocks(account.data),
    }, account)
  } catch (error) {
    response = {
      ok: false,
      error: String(error?.message || error),
    }
  }

  const latest = (await read(task.nick)) || account
  latest.data ||= {}
  const timestamp = Number(now()) || Date.now()
  if (response?.ok && response.summary?.text) {
    if (!completeDailyReportRun(latest.data, {
      runKey: task.runKey,
      session: task.session,
      summary: response.summary,
      now: timestamp,
    })) {
      return { ok: false, skipped: 'stale-task' }
    }
    latest.data.adviceDailyReport = {
      summary: response.summary,
      at: timestamp,
      source: response.cached ? 'scheduled-cache' : 'scheduled',
    }
    await write(latest)
    return {
      ok: true,
      session: task.session,
      runKey: task.runKey,
      cached: response.cached === true,
    }
  }

  failDailyReportRun(latest.data, {
    runKey: task.runKey,
    session: task.session,
    error: response?.error || '日报生成失败',
    now: timestamp,
  })
  await write(latest)
  return {
    ok: false,
    session: task.session,
    runKey: task.runKey,
    error: response?.error || '日报生成失败',
  }
}

export async function scheduleDueDailyReports(
  accounts,
  { now = Date.now() } = {},
  dependencies = {},
) {
  const write = dependencies.write || defaultWrite
  const dispatch = dependencies.dispatch || dispatchDailyReportWorker
  const isAuthorized = dependencies.isAuthorized || isAuthorizedAccount
  const totals = {
    accounts: Array.isArray(accounts) ? accounts.length : 0,
    claimed: 0,
    dispatched: 0,
    failed: 0,
  }
  for (const source of accounts || []) {
    if (!isAccountActive(source) || !isAuthorized(source)) continue
    const account = structuredClone(source)
    account.data ||= {}
    const claim = claimDueDailyReport(account.data, { now })
    if (!claim) continue
    totals.claimed++
    try {
      await write(account)
      const result = await dispatch({
        nick: account.nick,
        session: claim.session,
        runKey: claim.runKey,
      })
      if (result?.accepted) totals.dispatched++
      else throw new Error('异步日报Worker未受理')
    } catch (error) {
      totals.failed++
      failDailyReportRun(account.data, {
        runKey: claim.runKey,
        session: claim.session,
        error: error?.message || error,
        now: Date.now(),
      })
      try { await write(account) } catch { /* 下轮扫描会回收过期租约 */ }
    }
  }
  return totals
}

function send(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  const cronKey = process.env.CRON_KEY
  const supplied = req.headers['x-cron-key']
    || req.query?.key
    || req.body?.key
  if (!cronKey || supplied !== cronKey) {
    return send(res, 401, { ok: false, error: 'unauthorized' })
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  try {
    if (body.dailyReportWorker === true) {
      const result = await processDailyReportAccount({
        nick: String(body.nick || ''),
        session: String(body.session || ''),
        runKey: String(body.runKey || ''),
      })
      return send(res, 200, result)
    }
    if (body.scheduled === true) {
      const accounts = await listAllAccounts()
      const result = await scheduleDueDailyReports(accounts)
      return send(res, 200, { ok: true, ...result })
    }
    return send(res, 400, { ok: false, error: 'invalid operation' })
  } catch (error) {
    return send(res, 500, {
      ok: false,
      error: String(error?.message || error),
    })
  }
}
