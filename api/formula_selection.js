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
  opportunityRadarLedgerStore,
} from './_opportunity_radar_ledger_store.js'
import {
  fetchOpportunityScores,
} from './_opportunity_score.js'
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
  isTradingDayAt,
} from '../shared/tradingCalendar.js'
import {
  buildOpportunityRadarLedgerBatch,
} from '../shared/opportunityRadarLedger.js'
import {
  buildOpportunityScoreInput,
} from '../shared/opportunityScoreContract.js'

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

export function canRunFormulaSelectionMode(mode, now = Date.now()) {
  if (mode === 'intraday') return isContinuousTrading(now)
  if (mode === 'close') {
    return isTradingDayAt(now) && beijingMinutes(now) >= 15 * 60
  }
  return false
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
  ledgerStore = opportunityRadarLedgerStore,
  scoreOpportunities = fetchOpportunityScores,
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
      const scanned = await scan({
        mode: normalized,
        marketContext,
        now: timestamp,
        onProgress: reportProgress,
      })
      const marketBlocker =
        marketContext?.marketGate?.blockers?.[0]
        || '当前市场环境不支持新增风险'
      const resultTradeDate =
        scanned.universe?.tradeDate || tradeDate
      const ledgerBatch = buildOpportunityRadarLedgerBatch({
        mode: normalized,
        tradeDate: resultTradeDate,
        slot,
        generatedAt: timestamp,
        universe: scanned.universe,
        marketGate: marketContext?.marketGate || null,
        events: scanned.candidateEvents || [],
      })
      const scoreInputs = ledgerBatch.events
        .filter((event) => event.decision?.priceContractValid === true)
        .map((event) => buildOpportunityScoreInput({
          event,
          batch: ledgerBatch,
        }))
      const scoreInputMap = new Map(
        scoreInputs.map((input) => [input.code, input]),
      )
      const scoreMap = await scoreOpportunities(scoreInputs)
        .catch(() => new Map())
      ledgerBatch.events = ledgerBatch.events.map((event) => ({
        ...event,
        scoreInput: scoreInputMap.get(event.code) || null,
        opportunityScore: scoreMap.get(event.code) || null,
      }))
      const scoredCandidates = scanned.candidates.map((candidate) => ({
        ...candidate,
        opportunityScore: scoreMap.get(candidate.code) || null,
      }))
      const readyScores = [...scoreMap.values()].filter(
        (score) => score?.state === 'READY',
      ).length
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
        candidates: scoredCandidates,
        shadowRanking: {
          requested: scoreInputs.length,
          ready: readyScores,
          unavailable: Math.max(0, scoreInputs.length - readyScores),
          appliedToOrder: false,
        },
        ledger: {
          schemaVersion: ledgerBatch.schemaVersion,
          runId: ledgerBatch.runId,
          summary: ledgerBatch.summary,
        },
        decision: scoredCandidates.length ? 'OBSERVE' : 'NO_MATCH',
        reason: scoredCandidates.length
          ? marketAllowed
            ? `筛出${scoredCandidates.length}只公式观察股`
            : `已完成${scoredCandidates.length}只个股价格计算；${marketBlocker}，本次不买`
          : marketAllowed
            ? '当前没有股票通过公式和风险条件'
            : `已完成全市场个股计算；${marketBlocker}，且当前没有股票形成有效公式价格`,
      }
      await reportProgress({
        stage: 'SAVING',
        percent: 99,
        message: '正在保存本次公式结果',
      }, { force: true })
      await ledgerStore.saveBatch(ledgerBatch)
      await store.saveRun(normalized, result)
      await reportProgress({
        status: 'DONE',
        stage: 'DONE',
        percent: 100,
        message: scoredCandidates.length
          ? marketAllowed
            ? `已生成${scoredCandidates.length}只公式观察股`
            : `已完成${scoredCandidates.length}只个股价格计算，本次不买`
          : result.reason,
        counts: {
          total: scanned.universe?.total || 0,
          inspected: scanned.universe?.inspectedCount || 0,
          prefiltered: scanned.universe?.prefilterCount || 0,
          technicalCandidates:
            scanned.universe?.technicalCandidateCount || 0,
          matched: scoredCandidates.length,
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

export function formulaSelectionPublicError(error) {
  const message = String(error?.message || error || '公式选股失败')
  if (
    /HTTP\s*\d{3}|fetch failed|timeout|timed out|aborted|empty .*kline|关键行情不完整/i
      .test(message)
  ) {
    return {
      error: '行情数据暂时不可用，请稍后重试',
      errorCode: 'MARKET_DATA_UNAVAILABLE',
    }
  }
  return {
    error: message.slice(0, 180),
    errorCode: 'FORMULA_SELECTION_FAILED',
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
      if (!expected || supplied !== expected || body.mode !== 'close') {
        return reply(res, 401, {
          ok: false,
          error: 'unauthorized',
          errorCode: 'UNAUTHORIZED',
        })
      }
      return reply(res, 200, await runFormulaSelection({ mode: 'close' }))
    }

    // 公式价位只依赖主快照中的持仓与设置，无需为鉴权扫描建议运行态。
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
    if (!canRunFormulaSelectionMode(mode)) {
      return reply(res, 422, {
        ok: false,
        error: mode === 'intraday'
          ? '盘中公式仅在连续竞价期间运行'
          : '次日关注仅在交易日收盘后手动生成',
        errorCode: 'WINDOW_CLOSED',
      })
    }
    return reply(res, 200, await runFormulaSelection({ mode }))
  } catch (error) {
    const failure = formulaSelectionPublicError(error)
    return reply(res, 500, {
      ok: false,
      ...failure,
    })
  }
}
