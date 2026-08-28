import {
  authenticateAccountRequest,
} from './_account_auth.js'
import {
  applyCors,
  preflight,
} from './_lib.js'
import {
  collectTailPickMarketContext,
  scanTailPickCandidates,
} from './_tail_pick_data.js'
import {
  tailPickStore,
} from './_tail_pick_store.js'
import {
  rankTailPickCandidates,
} from '../shared/tailPickRanking.js'
import {
  tailPickSession,
} from '../shared/tailPickPolicy.js'

export const TAIL_PICK_SCHEMA_VERSION = 'tail-pick.v1'

const generationFlights = new Map()

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

function publicCandidate(candidate) {
  return {
    code: candidate.code,
    name: candidate.name,
    rank: candidate.rank,
    score: candidate.score,
    quote: candidate.quote,
    intraday: candidate.intraday,
    fund: candidate.fund,
    tags: {
      industry: candidate.tags?.industry || '',
      concepts: (candidate.tags?.concepts || []).slice(0, 4),
    },
    sector: candidate.sectorOpportunity?.sector || null,
    formulaSignals: (candidate.formula?.signals || [])
      .map((item) => item.label),
    evidence: candidate.stockGate?.evidence || [],
    execution: candidate.execution,
  }
}

function noTradeResult({
  tradeDate,
  now,
  marketGate,
  universe = null,
  reason,
}) {
  return {
    ok: true,
    schemaVersion: TAIL_PICK_SCHEMA_VERSION,
    session: {
      tradeDate,
      dataAsOf: now,
      isLive: true,
      window: '14:50-14:55',
    },
    marketGate,
    result: {
      decision: 'NO_TRADE',
      validationState: 'PENDING_INTRADAY_BACKTEST',
      primaryCode: null,
      candidates: [],
      reason,
      universe,
    },
  }
}

async function saveProgress(store, task, stage, progress, message, now) {
  await store.saveTask({
    ...task,
    status: 'RUNNING',
    stage,
    progress,
    message,
    updatedAt: now(),
  })
}

export function runTailPickScan({
  store = tailPickStore,
  collectMarketContext = collectTailPickMarketContext,
  scanCandidates = scanTailPickCandidates,
  rankCandidates = rankTailPickCandidates,
  now = Date.now,
} = {}) {
  const requestedAt = Number(now()) || Date.now()
  const tradeDate = tailPickSession(requestedAt).tradeDate
  const existingFlight = generationFlights.get(tradeDate)
  if (existingFlight) return existingFlight

  const promise = (async () => {
    const existing = await store.readRun(tradeDate)
    const session = tailPickSession(requestedAt, {
      hasResult: !!existing,
    })
    if (existing) {
      return {
        ...existing,
        reused: true,
      }
    }
    if (!session.canRun) {
      const error = new Error(session.reason || '当前不在尾盘选股时间窗')
      error.code = 'WINDOW_CLOSED'
      throw error
    }
    const claim = await store.claimRun(tradeDate, requestedAt)
    if (!claim.acquired) {
      return {
        ok: true,
        schemaVersion: TAIL_PICK_SCHEMA_VERSION,
        session,
        task: await store.readTask(),
        running: true,
      }
    }
    const task = {
      id: `tp_${tradeDate.replaceAll('-', '')}_1450`,
      tradeDate,
      status: 'RUNNING',
      startedAt: requestedAt,
    }
    try {
      await saveProgress(
        store,
        task,
        'MARKET_GATE',
        10,
        '正在确认今天是否适合尾盘开仓',
        now,
      )
      const marketContext = await collectMarketContext()
      if (!marketContext.marketGate.allowed) {
        const result = noTradeResult({
          tradeDate,
          now: Number(now()) || Date.now(),
          marketGate: marketContext.marketGate,
          reason: marketContext.marketGate.blockers[0]
            || '今天不适合新增仓位',
        })
        await store.saveRun(result)
        await store.saveTask({
          ...task,
          status: 'DONE',
          stage: 'DONE',
          progress: 100,
          message: '大盘纪律未通过，今日不开仓',
          finishedAt: Number(now()) || Date.now(),
        })
        return result
      }

      await saveProgress(
        store,
        task,
        'FORMULA_SCAN',
        35,
        '正在扫描全市场公式信号',
        now,
      )
      const scanned = await scanCandidates({
        marketContext,
        now: Number(now()) || Date.now(),
      })
      await saveProgress(
        store,
        task,
        'DISCIPLINE_GATE',
        72,
        '正在排除高位、弱势和流动性风险',
        now,
      )
      const ranked = rankCandidates(scanned.candidates, {
        timestamp: Number(now()) || Date.now(),
      })
      const generatedAt = Number(now()) || Date.now()
      const result = {
        ok: true,
        schemaVersion: TAIL_PICK_SCHEMA_VERSION,
        session: {
          tradeDate,
          dataAsOf: generatedAt,
          isLive: true,
          window: '14:50-14:55',
        },
        marketGate: marketContext.marketGate,
        result: {
          ...ranked,
          reason: ranked.candidates.length
            ? '公式命中且纪律闸门通过；分钟级历史优势尚未完成验证，仅供观察'
            : '没有股票同时通过原公式、主线、位置、流动性和分时纪律',
          universe: scanned.universe,
          candidates: ranked.candidates.map(publicCandidate),
        },
      }
      await store.saveRun(result)
      await store.saveTask({
        ...task,
        status: 'DONE',
        stage: 'DONE',
        progress: 100,
        message: ranked.candidates.length
          ? `筛出${ranked.candidates.length}只公式观察股`
          : '没有合格标的，今日不开仓',
        finishedAt: generatedAt,
      })
      return result
    } catch (error) {
      await store.saveTask({
        ...task,
        status: 'FAILED',
        stage: 'FAILED',
        progress: 100,
        message: '尾盘选股失败',
        error: String(error?.message || error).slice(0, 180),
        finishedAt: Number(now()) || Date.now(),
      }).catch(() => {})
      throw error
    } finally {
      await store.releaseRun(claim).catch(() => {})
    }
  })()
  generationFlights.set(tradeDate, promise)
  promise.finally(() => {
    if (generationFlights.get(tradeDate) === promise) {
      generationFlights.delete(tradeDate)
    }
  }).catch(() => {})
  return promise
}

export async function readTailPickState({
  store = tailPickStore,
  timestamp = Date.now(),
} = {}) {
  const [latest, task] = await Promise.all([
    store.readLatest(),
    store.readTask(),
  ])
  const currentResult = latest?.session?.tradeDate
    === tailPickSession(timestamp).tradeDate
    ? latest
    : null
  return {
    schemaVersion: TAIL_PICK_SCHEMA_VERSION,
    session: tailPickSession(timestamp, {
      hasResult: !!currentResult,
    }),
    latest,
    currentResult,
    task,
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  try {
    const authentication = await authenticateAccountRequest(req)
    if (!authentication.ok || authentication.trusted) {
      return reply(res, 401, {
        ok: false,
        error: authentication.error || '请先登录',
        errorCode: 'UNAUTHORIZED',
      })
    }
    if (req.method === 'GET') {
      return reply(res, 200, {
        ok: true,
        ...await readTailPickState(),
      })
    }
    if (req.method !== 'POST') {
      return reply(res, 405, {
        ok: false,
        error: 'method not allowed',
        errorCode: 'METHOD_NOT_ALLOWED',
      })
    }
    const body = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {})
    if (body.action !== 'run') {
      return reply(res, 400, {
        ok: false,
        error: 'unknown action',
        errorCode: 'INVALID_ACTION',
      })
    }
    const expectedKey = `tail-pick:${
      tailPickSession().tradeDate
    }:1450`
    if (String(body.idempotencyKey || '') !== expectedKey) {
      return reply(res, 422, {
        ok: false,
        error: '尾盘选股请求标识无效，请刷新页面后重试',
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
      })
    }
    return reply(res, 200, await runTailPickScan())
  } catch (error) {
    const code = error?.code || 'TAIL_PICK_FAILED'
    return reply(res, code === 'WINDOW_CLOSED' ? 409 : 500, {
      ok: false,
      error: String(error?.message || error).slice(0, 240),
      errorCode: code,
    })
  }
}
