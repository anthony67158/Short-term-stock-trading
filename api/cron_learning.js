import {
  settleLearningEvents,
} from './_learning_settlement.js'
import {
  publishLearningTrainingView,
} from './_learning_training_view.js'
import {
  applyCors,
  preflight,
} from './_lib.js'

function reply(res, body, status = 200) {
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  if (typeof res.status === 'function') return res.status(status).send(
    JSON.stringify(body),
  )
  res.statusCode = status
  return res.end(JSON.stringify(body))
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  const expected = process.env.CRON_KEY
  const given = req.headers?.['x-cron-key']
    || req.body?.key
    || req.query?.key
  if (!expected || String(given || '') !== String(expected)) {
    return reply(res, { ok: false, error: 'unauthorized' }, 401)
  }
  try {
    const settlement = await settleLearningEvents()
    const published = await publishLearningTrainingView()
    return reply(res, {
      ok: true,
      settlement,
      manifest: published.manifest,
    })
  } catch (error) {
    console.error(
      '[cron_learning] failed',
      error?.code || error?.name || error?.message,
    )
    return reply(res, {
      ok: false,
      error: '每日学习数据管道执行失败',
    }, 503)
  }
}
