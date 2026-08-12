import { applyCors, preflight } from './_lib.js'
import { refreshV2Accuracy } from './_v2_accuracy_store.js'
import { refreshV21Accuracy } from './_v21_accuracy_store.js'

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
  const given = req.headers?.['x-cron-key'] || req.body?.key || req.query?.key
  if (expected && String(given || '') !== String(expected)) {
    return reply(res, { ok: false, error: 'unauthorized' }, 401)
  }
  try {
    const [accuracy, v21Accuracy] = await Promise.all([
      refreshV2Accuracy(),
      refreshV21Accuracy(),
    ])
    return reply(res, { ok: true, accuracy, v21Accuracy })
  } catch (error) {
    console.error('[cron_v2_accuracy] refresh failed', error?.code || error?.name || error?.message)
    return reply(res, { ok: false, error: 'V2/V2.1正确率刷新失败' }, 503)
  }
}
