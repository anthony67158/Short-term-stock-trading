import {
  authenticateAccountRequest,
} from './_account_auth.js'
import {
  applyCors,
  preflight,
} from './_lib.js'
import {
  buildStockFormulaSelection,
  scanFormulaSelectionCandidates,
} from './_formula_selection_data.js'
import {
  formulaSelectionStore,
} from './_formula_selection_store.js'
import {
  collectTailPickMarketContext,
} from './_tail_pick_data.js'
import {
  readTailPickState,
} from './tail_pick.js'
import {
  beijingDayKey,
  beijingMinutes,
  isContinuousTrading,
} from '../shared/tradingCalendar.js'

export const FORMULA_SELECTION_SCHEMA_VERSION = 'formula-selection.v1'

const runFlights = new Map()
const PROGRESS_STALE_MS = 4 * 60 * 1000

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

function normalizedMode(value) {
  const mode = String(value || '').toLowerCase()
  return ['intraday', 'close', 'tail'].includes(mode) ? mode : null
}

function modeSlot(mode, now) {
  if (mode === 'close') return '1505'
  const minutes = beijingMinutes(now)
  return String(Math.floor(minutes / 5) * 5).padStart(4, '0')
}

function createProgressReporter({
  store,
  mode,
  task,
  now,
}) {
  let current = task
  let lastStage = ''
  let lastPercent = -100
  let writeQueue = Promise.resolve()
  return async (update = {}, { force = false } = {}) => {
    const stage = String(update.stage || current.stage || 'PREPARING')
    const percent = Math.max(
      1,
      Math.min(100, Math.round(Number(update.percent) || 1)),
    )
    const shouldWrite = (
      force
      || stage !== lastStage
      || percent >= lastPercent + 3
    )
    current = {
      ...current,
      ...update,
      stage,
      percent,
      updatedAt: Number(now()) || Date.now(),
    }
    if (!shouldWrite || typeof store.saveProgress !== 'function') {
      return current
    }
    lastStage = stage
    lastPercent = percent
    const snapshot = current
    writeQueue = writeQueue
      .catch(() => {})
      .then(() => store.saveProgress(mode, snapshot).catch(() => snapshot))
    await writeQueue
    return snapshot
  }
}

export function runFormulaSelection({
  mode = 'intraday',
  store = formulaSelectionStore,
  scan = scanFormulaSelectionCandidates,
  collectMarketContext = collectTailPickMarketContext,
  now = Date.now,
} = {}) {
  const normalized = normalizedMode(mode)
  if (!normalized || normalized === 'tail') {
    return Promise.reject(new Error('公式选股运行模式无效'))
  }
  const timestamp = Number(now()) || Date.now()
  const tradeDate = beijingDayKey(timestamp)
  const slot = modeSlot(normalized, timestamp)
  const flightKey = `${tradeDate}:${normalized}:${slot}`
  if (runFlights.has(flightKey)) return runFlights.get(flightKey)

  const promise = (async () => {
    const existing = await store.readLatest(normalized)
    if (
      existing?.tradeDate === tradeDate
      && existing?.slot === slot
    ) return { ...existing, reused: true }
    const claim = await store.claimRun(
      normalized,
      tradeDate,
      slot,
      timestamp,
    )
    if (!claim.acquired) {
      return {
        ok: true,
        schemaVersion: FORMULA_SELECTION_SCHEMA_VERSION,
        mode: normalized.toUpperCase(),
        tradeDate,
        slot,
        running: true,
        task: typeof store.readProgress === 'function'
          ? await store.readProgress(normalized)
          : null,
      }
    }
    const task = {
      id: `formula-${tradeDate}-${normalized}-${slot}`,
      mode: normalized,
      tradeDate,
      slot,
      status: 'RUNNING',
      stage: 'MARKET_GATE',
      percent: 4,
      message: '正在核验市场环境与运行窗口',
      startedAt: timestamp,
      updatedAt: timestamp,
    }
    const reportProgress = createProgressReporter({
      store,
      mode: normalized,
      task,
      now,
    })
    try {
      await reportProgress(task, { force: true })
      const marketContext = await collectMarketContext({ now: timestamp })
      const marketAllowed = marketContext?.marketGate?.allowed === true
      const scanned = marketAllowed
        ? await scan({
            mode: normalized,
            marketContext,
            now: timestamp,
            onProgress: reportProgress,
          })
        : {
            universe: {
              inspectedCount: 0,
              formulaMatchCount: 0,
            },
            formulas: [],
            candidates: [],
          }
      const resultTradeDate =
        scanned.universe?.tradeDate || tradeDate
      const result = {
        ok: true,
        schemaVersion: FORMULA_SELECTION_SCHEMA_VERSION,
        mode: normalized.toUpperCase(),
        tradeDate: resultTradeDate,
        slot,
        generatedAt: timestamp,
        dataAsOf: timestamp,
        validationState: 'OBSERVE_ONLY',
        marketGate: marketContext?.marketGate || null,
        universe: scanned.universe,
        formulas: scanned.formulas,
        candidates: scanned.candidates,
        decision: scanned.candidates.length ? 'OBSERVE' : 'NO_MATCH',
        reason: scanned.candidates.length
          ? `筛出${scanned.candidates.length}只公式观察股`
          : marketAllowed
            ? '当前没有股票通过公式和风险条件'
            : marketContext?.marketGate?.blockers?.[0]
              || '市场环境不允许新增风险',
      }
      await reportProgress({
        stage: 'SAVING',
        percent: 99,
        message: '正在保存本次公式结果',
      }, { force: true })
      await store.saveRun(normalized, result)
      await reportProgress({
        status: 'DONE',
        stage: 'DONE',
        percent: 100,
        message: scanned.candidates.length
          ? `已生成${scanned.candidates.length}只公式观察股`
          : result.reason,
        counts: {
          total: scanned.universe?.total || 0,
          inspected: scanned.universe?.inspectedCount || 0,
          prefiltered: scanned.universe?.prefilterCount || 0,
          technicalCandidates:
            scanned.universe?.technicalCandidateCount || 0,
          matched: scanned.candidates.length,
        },
        finishedAt: Number(now()) || Date.now(),
      }, { force: true })
      return result
    } catch (error) {
      await reportProgress({
        status: 'FAILED',
        stage: 'FAILED',
        percent: 100,
        message: '公式计算失败',
        error: String(error?.message || error).slice(0, 180),
        finishedAt: Number(now()) || Date.now(),
      }, { force: true }).catch(() => {})
      throw error
    } finally {
      await store.releaseRun(claim).catch(() => {})
    }
  })()
  runFlights.set(flightKey, promise)
  promise.finally(() => {
    if (runFlights.get(flightKey) === promise) runFlights.delete(flightKey)
  }).catch(() => {})
  return promise
}

export async function readFormulaSelectionState({
  store = formulaSelectionStore,
  tailReader = readTailPickState,
} = {}) {
  const [
    intraday,
    close,
    tail,
    intradayProgress,
    closeProgress,
  ] = await Promise.all([
    store.readLatest('intraday'),
    store.readLatest('close'),
    tailReader().catch(() => null),
    readFormulaSelectionProgress({ mode: 'intraday', store }),
    readFormulaSelectionProgress({ mode: 'close', store }),
  ])
  return {
    schemaVersion: FORMULA_SELECTION_SCHEMA_VERSION,
    intraday,
    close,
    tail: tail?.displayResult || tail?.latest || null,
    progress: {
      intraday: intradayProgress,
      close: closeProgress,
    },
  }
}

export async function readFormulaSelectionProgress({
  mode,
  store = formulaSelectionStore,
  timestamp = Date.now(),
} = {}) {
  const normalized = normalizedMode(mode)
  if (!['intraday', 'close'].includes(normalized)) {
    throw new Error('公式选股运行模式无效')
  }
  const task = typeof store.readProgress === 'function'
    ? await store.readProgress(normalized)
    : null
  if (
    task?.status === 'RUNNING'
    && timestamp - Number(task.updatedAt || task.startedAt || 0)
      > PROGRESS_STALE_MS
  ) {
    return {
      ...task,
      status: 'FAILED',
      stage: 'FAILED',
      percent: 100,
      message: '上次公式计算已超时，可重新运行',
    }
  }
  return task
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
      if (!expected || supplied !== expected || body.mode !== 'close') {
        return reply(res, 401, {
          ok: false,
          error: 'unauthorized',
          errorCode: 'UNAUTHORIZED',
        })
      }
      return reply(res, 200, await runFormulaSelection({ mode: 'close' }))
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
      const view = String(req.query?.view || 'latest')
      if (view === 'progress') {
        const mode = normalizedMode(req.query?.mode)
        if (!['intraday', 'close'].includes(mode)) {
          return reply(res, 400, {
            ok: false,
            error: '运行模式无效',
            errorCode: 'INVALID_MODE',
          })
        }
        return reply(res, 200, {
          ok: true,
          task: await readFormulaSelectionProgress({ mode }),
        })
      }
      if (view === 'stock') {
        const code = String(req.query?.code || '')
        if (!/^\d{6}$/.test(code)) {
          return reply(res, 400, {
            ok: false,
            error: '股票代码无效',
            errorCode: 'INVALID_CODE',
          })
        }
        return reply(res, 200, {
          ok: true,
          ...await buildStockFormulaSelection({
            code,
            account: authentication.account,
          }),
        })
      }
      if (view !== 'latest') {
        return reply(res, 400, {
          ok: false,
          error: '查询视图无效',
          errorCode: 'INVALID_VIEW',
        })
      }
      return reply(res, 200, {
        ok: true,
        ...await readFormulaSelectionState(),
      })
    }
    if (req.method !== 'POST') {
      return reply(res, 405, {
        ok: false,
        error: 'method not allowed',
        errorCode: 'METHOD_NOT_ALLOWED',
      })
    }
    const mode = normalizedMode(body.mode)
    if (!['intraday', 'close'].includes(mode)) {
      return reply(res, 400, {
        ok: false,
        error: '运行模式无效',
        errorCode: 'INVALID_MODE',
      })
    }
    if (mode === 'intraday' && !isContinuousTrading()) {
      return reply(res, 422, {
        ok: false,
        error: '盘中公式仅在连续竞价期间运行',
        errorCode: 'WINDOW_CLOSED',
      })
    }
    return reply(res, 200, await runFormulaSelection({ mode }))
  } catch (error) {
    return reply(res, 500, {
      ok: false,
      error: String(error?.message || '公式选股失败').slice(0, 180),
      errorCode: 'FORMULA_SELECTION_FAILED',
    })
  }
}
