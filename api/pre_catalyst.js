import {
  authenticateAccountRequest,
  authorizePaidRequest,
} from './_account_auth.js'
import {
  applyCors,
  preflight,
} from './_lib.js'
import {
  collectPreCatalystSnapshot,
} from './_pre_catalyst_data.js'
import {
  preCatalystStore,
} from './_pre_catalyst_store.js'

const runFlights = new Map()
const REUSE_MS = 10 * 60 * 1000

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

function publicError(error) {
  const detail = String(error?.message || error || '')
  if (
    /巨潮资讯HTTP|fetch failed|timeout|aborted|全市场|行情|K线/i
      .test(detail)
  ) {
    return {
      error: '预催化数据暂时不可用，请稍后重试',
      errorCode: 'PRE_CATALYST_SOURCE_UNAVAILABLE',
    }
  }
  return {
    error: detail.slice(0, 180) || '预催化扫描失败',
    errorCode: 'PRE_CATALYST_FAILED',
  }
}

export function runPreCatalystScan({
  store = preCatalystStore,
  collect = collectPreCatalystSnapshot,
  force = false,
  now = Date.now,
} = {}) {
  const timestamp = Number(now()) || Date.now()
  const slot = Math.floor(timestamp / REUSE_MS)
  const flightKey = String(slot)
  if (runFlights.has(flightKey)) return runFlights.get(flightKey)

  const promise = (async () => {
    const previous = await store.readLatest()
    if (
      !force
      && previous?.generatedAt
      && timestamp - Number(previous.generatedAt) < REUSE_MS
    ) {
      return { ok: true, reused: true, snapshot: previous }
    }
    const claim = await store.claimRun(timestamp)
    if (!claim.acquired) {
      return {
        ok: true,
        running: true,
        snapshot: previous,
        task: await store.readProgress(),
      }
    }
    const baseTask = {
      id: `pre-catalyst-${timestamp}`,
      status: 'RUNNING',
      stage: 'ANNOUNCEMENTS',
      percent: 8,
      message: '正在读取官方公告与投资者关系记录',
      startedAt: timestamp,
      updatedAt: timestamp,
    }
    let task = baseTask
    const report = async (update = {}) => {
      task = {
        ...task,
        ...update,
        status: 'RUNNING',
        updatedAt: Number(now()) || Date.now(),
      }
      await store.saveProgress(task)
    }
    try {
      await store.saveProgress(baseTask)
      const snapshot = await collect({
        now: timestamp,
        previous,
        readRelations: () => store.readRelations(),
        onProgress: report,
      })
      await store.saveSnapshot(snapshot)
      const completed = {
        ...task,
        status: 'DONE',
        stage: 'DONE',
        percent: 100,
        message:
          `发现${Number(snapshot?.candidates?.length) || 0}只潜伏候选`,
        finishedAt: Number(now()) || Date.now(),
        updatedAt: Number(now()) || Date.now(),
        tradeDate: snapshot.tradeDate,
      }
      await store.saveProgress(completed)
      return { ok: true, snapshot, task: completed }
    } catch (error) {
      const failed = {
        ...task,
        status: 'FAILED',
        stage: 'FAILED',
        percent: 100,
        message: '预催化扫描失败',
        error: publicError(error).error,
        finishedAt: Number(now()) || Date.now(),
        updatedAt: Number(now()) || Date.now(),
      }
      await store.saveProgress(failed).catch(() => null)
      throw error
    } finally {
      await store.releaseRun(claim).catch(() => false)
    }
  })().finally(() => {
    if (runFlights.get(flightKey) === promise) runFlights.delete(flightKey)
  })
  runFlights.set(flightKey, promise)
  return promise
}

export async function readPreCatalystState(
  store = preCatalystStore,
) {
  const [latest, task, evaluation] = await Promise.all([
    store.readLatest(),
    store.readProgress(),
    store.readEvaluation(),
  ])
  return { latest, task, evaluation }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  try {
    const body = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {})
    const action = String(
      body.action || req.query?.action || 'latest',
    )
    if (req.method === 'POST' && body.scheduled === true) {
      const expected = String(process.env.CRON_KEY || '')
      const supplied = String(
        req.headers?.['x-cron-key']
        || body.key
        || req.query?.key
        || '',
      )
      if (!expected || supplied !== expected) {
        return reply(res, 401, {
          ok: false,
          error: 'unauthorized',
          errorCode: 'UNAUTHORIZED',
        })
      }
      return reply(res, 200, await runPreCatalystScan())
    }
    if (req.method === 'GET') {
      const authentication = await authenticateAccountRequest(req, {
        includeAdviceRuntime: false,
      })
      if (!authentication.ok || authentication.trusted) {
        return reply(res, 401, {
          ok: false,
          error: authentication.error || '请先登录',
          errorCode: 'UNAUTHORIZED',
        })
      }
      return reply(res, 200, {
        ok: true,
        ...await readPreCatalystState(),
      })
    }
    if (req.method !== 'POST' || action !== 'run') {
      return reply(res, 405, {
        ok: false,
        error: 'method not allowed',
        errorCode: 'METHOD_NOT_ALLOWED',
      })
    }
    const authorization = await authorizePaidRequest(req)
    if (!authorization.ok || authorization.trusted) {
      return reply(
        res,
        authorization.error === '请先登录' ? 401 : 403,
        {
          ok: false,
          error: authorization.error || '账号鉴权失败',
          errorCode: 'UNAUTHORIZED',
        },
      )
    }
    return reply(res, 200, await runPreCatalystScan({
      force: body.force === true,
    }))
  } catch (error) {
    const failure = publicError(error)
    return reply(res, 503, {
      ok: false,
      ...failure,
    })
  }
}
