import { applyCors, preflight } from './_lib.js'
import { authorizePaidRequest } from './_account_auth.js'
import { writeAccount } from './account.js'
import {
  dailyReportScheduleFromSettings,
  withDailyReportSchedule,
} from '../shared/dailyReportSchedule.js'

function responseFor(account) {
  const data = account?.data || {}
  return {
    ok: true,
    settings: dailyReportScheduleFromSettings(data.settings || {}),
    state: data.dailyReportAuto || null,
  }
}

function send(res, statusCode, payload) {
  res.status(statusCode)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  return res.send(JSON.stringify(payload))
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  try {
    const auth = await authorizePaidRequest(req)
    if (!auth.ok) {
      return send(
        res,
        auth.error === '请先登录' ? 401 : 403,
        { ok: false, error: auth.error },
      )
    }

    let body = req.body
    if (typeof body === 'string') body = JSON.parse(body || '{}')
    const action = String(body?.action || req.query?.action || 'get')
    if (action === 'get') {
      return send(res, 200, responseFor(auth.account))
    }
    if (action !== 'save') {
      return send(
        res,
        400,
        { ok: false, error: '未知 action' },
      )
    }

    const account = auth.account
    account.data ||= {}
    account.data.settings = withDailyReportSchedule(
      account.data.settings || {},
      body?.settings || {},
    )
    const saved = await writeAccount(account)
    return send(res, 200, responseFor(saved))
  } catch (error) {
    const status = Number(error?.status) || 500
    return send(
      res,
      status,
      { ok: false, error: String(error?.message || error) },
    )
  }
}
