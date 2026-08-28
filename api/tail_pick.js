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
import { fetchTrendsTx } from './stock_detail.js'
import {
  tailPickStore,
} from './_tail_pick_store.js'
import {
  rankTailPickCandidates,
  rankTailPickNearCandidates,
} from '../shared/tailPickRanking.js'
import {
  evaluateTailPickIntraday,
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
    nearMatch: candidate.nearMatch
      ? {
          passedCount: candidate.nearMatch.passedCount,
          totalRuleCount: candidate.nearMatch.totalRuleCount,
          matchRate: candidate.nearMatch.matchRate,
          failedRules: (candidate.nearMatch.failedRules || [])
            .map((item) => ({
              key: item.key,
              label: item.label,
            })),
        }
      : null,
    evidence: candidate.stockGate?.evidence || [],
    blockers: candidate.stockGate?.blockers || [],
    execution: candidate.execution,
  }
}

function noTradeResult({
  tradeDate,
  now,
  mode,
  isLive,
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
      isLive,
      window: '14:50-14:55',
      mode,
      isFormal: mode === 'scheduled',
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
  mode = 'manual',
} = {}) {
  const requestedAt = Number(now()) || Date.now()
  const tradeDate = tailPickSession(requestedAt).tradeDate
  const runMode = mode === 'scheduled' ? 'scheduled' : 'manual'
  const flightKey = `${runMode}:${tradeDate}`
  const existingFlight = generationFlights.get(flightKey)
  if (existingFlight) return existingFlight

  const promise = (async () => {
    const existing = runMode === 'scheduled'
      ? await store.readRun(tradeDate)
      : null
    const session = tailPickSession(requestedAt, {
      hasResult: !!existing,
    })
    if (existing) {
      return {
        ...existing,
        reused: true,
      }
    }
    if (runMode === 'scheduled' && session.status === 'REST') {
      return {
        ok: true,
        skipped: true,
        reason: 'non-trading-day',
        schemaVersion: TAIL_PICK_SCHEMA_VERSION,
        session,
      }
    }
    if (runMode === 'scheduled' && !session.formalRunDue) {
      const error = new Error('自动正式扫描仅在交易日14:50-14:55运行')
      error.code = 'WINDOW_CLOSED'
      throw error
    }
    const activeTask = typeof store.readTask === 'function'
      ? await store.readTask()
      : null
    if (
      activeTask?.status === 'RUNNING'
      && requestedAt
        - Number(activeTask.updatedAt || activeTask.startedAt || 0)
        < 3 * 60 * 1000
    ) {
      return {
        ok: true,
        schemaVersion: TAIL_PICK_SCHEMA_VERSION,
        session,
        task: activeTask,
        running: true,
      }
    }
    const claim = await store.claimRun(tradeDate, requestedAt, runMode)
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
      id: `tp_${tradeDate.replaceAll('-', '')}_${runMode}`,
      tradeDate,
      mode: runMode,
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
      const marketContext = await collectMarketContext({
        now: requestedAt,
      })
      if (!marketContext.marketGate.allowed) {
        const result = noTradeResult({
          tradeDate,
          now: Number(now()) || Date.now(),
          mode: runMode,
          isLive: session.status === 'OPEN',
          marketGate: marketContext.marketGate,
          reason: marketContext.marketGate.blockers[0]
            || '今天不适合新增仓位',
        })
        if (runMode === 'scheduled') await store.saveRun(result)
        else await store.saveManualRun(result)
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
        maxPositionPct:
          marketContext.marketGate.maxPositionPct,
      })
      const nearRanked = rankTailPickNearCandidates(
        scanned.nearCandidates,
      )
      const generatedAt = Number(now()) || Date.now()
      const result = {
        ok: true,
        schemaVersion: TAIL_PICK_SCHEMA_VERSION,
        session: {
          tradeDate,
          dataAsOf: generatedAt,
          isLive: session.status === 'OPEN',
          window: '14:50-14:55',
          mode: runMode,
          isFormal: runMode === 'scheduled',
        },
        marketGate: marketContext.marketGate,
        result: {
          ...ranked,
          reason: ranked.candidates.length
            ? '公式命中且纪律闸门通过；分钟级历史优势尚未完成验证，仅供观察'
            : nearRanked.length
              ? `原公式今日无完整命中；另筛出${nearRanked.length}只接近公式观察股`
              : '没有股票同时通过原公式或接近公式观察条件',
          universe: scanned.universe,
          candidates: ranked.candidates.map((candidate) => {
            const value = publicCandidate(candidate)
            if (runMode === 'scheduled') return value
            return {
              ...value,
              liveStatus: 'MANUAL_PREVIEW',
              execution: {
                ...value.execution,
                action: session.status === 'OPEN'
                  ? value.execution.action
                  : '手动试算命中：仅加入自选观察，不在当前时点买入',
                ...(session.status === 'OPEN'
                  ? {}
                  : { firstLeg: null, secondLeg: null }),
              },
            }
          }),
          nearCandidates: nearRanked.map((candidate) => ({
            ...publicCandidate(candidate),
            liveStatus: 'WATCH_ONLY',
            execution: {
              ...candidate.execution,
              action: '接近公式：仅加入自选观察，条件补齐前不买',
            },
          })),
        },
      }
      if (runMode === 'scheduled') await store.saveRun(result)
      else await store.saveManualRun(result)
      await store.saveTask({
        ...task,
        status: 'DONE',
        stage: 'DONE',
        progress: 100,
        message: ranked.candidates.length
          ? `筛出${ranked.candidates.length}只公式观察股`
          : nearRanked.length
            ? `严格公式未命中，筛出${nearRanked.length}只接近公式观察股`
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
  generationFlights.set(flightKey, promise)
  promise.finally(() => {
    if (generationFlights.get(flightKey) === promise) {
      generationFlights.delete(flightKey)
    }
  }).catch(() => {})
  return promise
}

export async function readTailPickState({
  store = tailPickStore,
  fetchTrends = fetchTrendsTx,
  timestamp = Date.now(),
} = {}) {
  const [formalLatest, manualLatest, task] = await Promise.all([
    store.readLatest(),
    store.readManualLatest(),
    store.readTask(),
  ])
  const currentResult = formalLatest?.session?.tradeDate
    === tailPickSession(timestamp).tradeDate
    ? formalLatest
    : null
  const projected = currentResult
    ? await projectTailPickLiveStatus(currentResult, {
        fetchTrends,
        timestamp,
      })
    : null
  const latestDisplay = [manualLatest, formalLatest]
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.session?.dataAsOf || 0)
      - Number(left.session?.dataAsOf || 0)
    )[0] || null
  const visibleTask = (
    task?.status === 'RUNNING'
    && timestamp - Number(task.updatedAt || task.startedAt || 0)
      > 3 * 60 * 1000
  )
    ? {
        ...task,
        status: 'FAILED',
        stage: 'FAILED',
        message: '上次任务已超时，可重新手动试算',
      }
    : task
  return {
    schemaVersion: TAIL_PICK_SCHEMA_VERSION,
    session: tailPickSession(timestamp, {
      hasResult: !!currentResult,
    }),
    latest: formalLatest,
    manualLatest,
    currentResult: projected,
    displayResult: projected || latestDisplay,
    task: visibleTask,
  }
}

export async function projectTailPickLiveStatus(
  result,
  {
    fetchTrends = fetchTrendsTx,
    timestamp = Date.now(),
  } = {},
) {
  const candidates = Array.isArray(result?.result?.candidates)
    ? result.result.candidates
    : []
  if (!candidates.length) return result
  const session = tailPickSession(timestamp, { hasResult: true })
  if (result.session?.tradeDate !== session.tradeDate) {
    return {
      ...result,
      result: {
        ...result.result,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          liveStatus: 'HISTORY',
          execution: {
            ...candidate.execution,
            action: '历史结果，仅供复盘',
          },
        })),
      },
    }
  }
  if (session.status !== 'OPEN') {
    return {
      ...result,
      result: {
        ...result.result,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          liveStatus: 'WINDOW_CLOSED',
          execution: {
            ...candidate.execution,
            action: '执行窗口已结束，不再买入',
          },
        })),
      },
    }
  }
  const refreshed = await Promise.all(candidates.map(async (candidate) => {
    const data = await fetchTrends(candidate.code).catch(() => null)
    const intraday = data?.trends?.length
      ? evaluateTailPickIntraday(data.trends)
      : {
          passed: false,
          blockers: ['实时分时更新失败'],
          evidence: [],
        }
    return {
      ...candidate,
      intraday,
      liveStatus: intraday.passed ? 'READY' : 'ABANDON',
      execution: intraday.passed
        ? candidate.execution
        : {
            ...candidate.execution,
            action: `放弃买入：${
              intraday.blockers?.[0] || '分时纪律失效'
            }`,
            firstLeg: null,
            secondLeg: null,
          },
    }
  }))
  return {
    ...result,
    result: {
      ...result.result,
      candidates: refreshed,
    },
  }
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
      return reply(res, 200, await runTailPickScan({
        mode: 'scheduled',
      }))
    }
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
    if (body.action !== 'run') {
      return reply(res, 400, {
        ok: false,
        error: 'unknown action',
        errorCode: 'INVALID_ACTION',
      })
    }
    const tradeDate = tailPickSession().tradeDate
    const idempotencyKey = String(body.idempotencyKey || '')
    const expectedPattern = new RegExp(
      `^tail-pick:${tradeDate}:manual:\\d{13}$`,
    )
    if (!expectedPattern.test(idempotencyKey)) {
      return reply(res, 422, {
        ok: false,
        error: '尾盘选股请求标识无效，请刷新页面后重试',
        errorCode: 'INVALID_IDEMPOTENCY_KEY',
      })
    }
    return reply(res, 200, await runTailPickScan({
      mode: 'manual',
    }))
  } catch (error) {
    const code = error?.code || 'TAIL_PICK_FAILED'
    return reply(res, code === 'WINDOW_CLOSED' ? 409 : 500, {
      ok: false,
      error: String(error?.message || error).slice(0, 240),
      errorCode: code,
    })
  }
}
