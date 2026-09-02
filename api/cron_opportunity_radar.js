import {
  applyCors,
  preflight,
} from './_lib.js'
import {
  settleOpportunityRadarOutcomes,
} from './_opportunity_radar_settlement.js'
import {
  refreshOpportunityRadarBaseline,
} from './_opportunity_radar_baseline.js'

function reply(res, body, status = 200) {
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.statusCode = status
  return res.end(JSON.stringify(body))
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  const expected = process.env.CRON_KEY
  const given =
    req.headers?.['x-cron-key']
    || req.body?.key
    || req.query?.key
  if (expected && String(given || '') !== String(expected)) {
    return reply(res, { ok: false, error: 'unauthorized' }, 401)
  }
  try {
    const settlement = await settleOpportunityRadarOutcomes()
    const baseline = await refreshOpportunityRadarBaseline()
    return reply(res, { ok: true, settlement, baseline })
  } catch (error) {
    console.error(
      '[cron_opportunity_radar] settlement failed',
      error?.code || error?.name || error?.message,
    )
    return reply(res, {
      ok: false,
      error: '机会雷达结果结算失败',
    }, 503)
  }
}
