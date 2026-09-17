// 选股服务入口：GET 读最新选股快照；POST { action:'run' } 触发全市场召回+排序。
// 鉴权复用账户请求；单飞锁避免并发全市场扫描重复计费。Agent 精选(action:'agent')在 S4 接入。
import {
  authenticateAccountRequest,
} from './_account_auth.js'
import {
  applyCors,
  preflight,
} from './_lib.js'
import {
  buildStockPickRecall,
} from './_stock_pick_recall.js'
import {
  generateStockPickAgentSelection,
} from './_stock_pick_agent.js'
import {
  stockPickStore,
} from './_stock_pick_store.js'
import {
  captureStockPickAgentSelection,
  captureStockPickPrediction,
} from './_learning_capture.js'
import {
  unavailableStockPickSnapshot,
} from '../shared/stockPick.js'
import {
  topStockPickReferences,
  unavailableStockPickAgentSelection,
} from '../shared/stockPickAgent.js'
import {
  STOCK_PICK_MODE,
  STOCK_PICK_MODES,
  appendStockPickTrace,
  createStockPickTrace,
  firstQuoteRecalculationCodes,
  normalizeNextDaySelection,
  normalizeStockPickMode,
} from '../shared/stockPickModes.js'
import { fetchQuotes } from './quote.js'
import { randomUUID } from 'node:crypto'

const runFlights = new Map()
const modeIds = STOCK_PICK_MODES.map((item) => item.id)

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

export async function handleStockPickRun({
  store = stockPickStore,
  recall = buildStockPickRecall,
  now = Date.now,
} = {}) {
  const key = 'run'
  if (runFlights.has(key)) return runFlights.get(key)
  const promise = (async () => {
    const startedAt = Number(now()) || Date.now()
    const claim = await store.claimRun(startedAt)
    if (!claim.acquired) {
      const latest = await store.readLatest()
      return { ok: true, running: true, snapshot: latest || null }
    }
    try {
      await store.saveProgress({
        status: 'RUNNING',
        stage: 'RECALL',
        percent: 10,
        message: '正在全市场扫描召回候选',
        startedAt,
        updatedAt: startedAt,
      })
      const snapshot = await recall({
        now: startedAt,
        onProgress: async (progress) => {
          await store.saveProgress({
            status: 'RUNNING',
            ...progress,
            startedAt,
            updatedAt: Number(now()) || Date.now(),
          })
        },
      })
      await store.saveLatest(snapshot)
      await captureStockPickPrediction(snapshot).catch((error) => {
        console.warn(
          '[learning] stock-pick prediction capture failed',
          error?.code || error?.message,
        )
      })
      const finishedAt = Number(now()) || Date.now()
      await store.saveProgress({
        status: 'DONE',
        stage: 'DONE',
        percent: 100,
        message: snapshot.availability === 'READY'
          ? `召回 ${snapshot.candidates.length} 只候选`
          : snapshot.reason || '本轮无候选',
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
      })
      return { ok: true, snapshot }
    } catch (error) {
      const snapshot = unavailableStockPickSnapshot({
        reasonCode: 'RECALL_FAILED',
        reason: String(error?.message || '选股召回失败'),
        now: Number(now()) || Date.now(),
      })
      await store.saveLatest(snapshot)
      await store.saveProgress({
        status: 'FAILED',
        stage: 'FAILED',
        percent: 100,
        message: snapshot.reason,
        updatedAt: Number(now()) || Date.now(),
      })
      return { ok: true, snapshot }
    } finally {
      await store.releaseRun()
    }
  })().finally(() => {
    if (runFlights.get(key) === promise) runFlights.delete(key)
  })
  runFlights.set(key, promise)
  return promise
}

export async function handleStockPickAgent({
  store = stockPickStore,
  generate = generateStockPickAgentSelection,
  now = Date.now,
  mode = STOCK_PICK_MODE.INTRADAY,
  codes = [],
  trigger = 'INITIAL',
  scope = '',
} = {}) {
  const normalizedMode = normalizeStockPickMode(mode)
  const snapshot = await store.readLatest()
  if (!snapshot || snapshot.availability !== 'READY' || !snapshot.candidates?.length) {
    const selection = unavailableStockPickAgentSelection({
      reasonCode: 'NO_RECALL_SNAPSHOT',
      reason: '请先运行全市场召回',
      mode: normalizedMode,
      trigger,
      now: Number(now()) || Date.now(),
    })
    await store.saveAgent(selection, normalizedMode, scope)
    return { ok: true, selection, references: [] }
  }
  const startedAt = Number(now()) || Date.now()
  const agentRunId = randomUUID()
  const flightKey = `${scope || 'global'}:${normalizedMode}`
  if (runFlights.has(flightKey)) return runFlights.get(flightKey)
  const promise = (async () => {
    const claim = await store.claimAgentRun({
      mode: normalizedMode,
      scope,
      runKey: agentRunId,
      now: startedAt,
    })
    if (!claim.acquired) {
      return {
        ok: true,
        running: true,
        selection: await store.readAgent(normalizedMode, scope),
        progress: await store.readAgentProgress(normalizedMode, scope),
        references: [],
      }
    }
    let trace = createStockPickTrace({
      mode: normalizedMode,
      runId: agentRunId,
      trigger,
      now: startedAt,
    })
    await store.saveAgentProgress(trace, normalizedMode, scope)
    const onTrace = async (event) => {
      trace = appendStockPickTrace(
        trace,
        event,
        Number(now()) || Date.now(),
      )
      await store.saveAgentProgress(trace, normalizedMode, scope)
    }
    try {
      const selection = await generate({
        snapshot,
        mode: normalizedMode,
        codes,
        trigger,
        agentRunId,
        now: startedAt,
        onTrace,
      })
      await store.saveAgent(selection, normalizedMode, scope)
      await captureStockPickAgentSelection(selection, {
        accountScope: scope,
        snapshot,
      }).catch((error) => {
        console.warn(
          '[learning] stock-pick agent capture failed',
          error?.code || error?.message,
        )
      })
      if (trace.status === 'RUNNING') {
        await onTrace({
          type: selection.availability === 'READY' ? 'result' : 'error',
          status: selection.availability === 'READY' ? 'done' : 'error',
          stage: selection.availability === 'READY' ? 'DONE' : 'FAILED',
          percent: 100,
          runStatus: selection.availability === 'READY' ? 'DONE' : 'FAILED',
          label: selection.availability === 'READY'
            ? '选股研判完成'
            : '选股研判不可用',
          detail: selection.reason
            || selection.stageAssessment
            || selection.overallReason,
        })
      }
      const references = (
        selection.conclusion === 'SELECT'
        && selection.selections.length
      ) ? [] : topStockPickReferences(snapshot)
      return { ok: true, selection, progress: trace, references }
    } catch (error) {
      const selection = unavailableStockPickAgentSelection({
        reasonCode: 'AGENT_FAILED',
        reason: String(error?.message || '选股 Agent 执行失败'),
        mode: normalizedMode,
        trigger,
        agentRunId,
        now: Number(now()) || Date.now(),
      })
      await store.saveAgent(selection, normalizedMode, scope)
      await onTrace({
        type: 'error',
        status: 'error',
        stage: 'FAILED',
        percent: 100,
        runStatus: 'FAILED',
        label: '选股研判失败',
        detail: selection.reason,
      })
      return { ok: true, selection, progress: trace, references: [] }
    } finally {
      await store.releaseAgentRun(normalizedMode, scope)
    }
  })().finally(() => {
    if (runFlights.get(flightKey) === promise) runFlights.delete(flightKey)
  })
  runFlights.set(flightKey, promise)
  return promise
}

export async function handleNextDaySelection({
  store = stockPickStore,
  codes = [],
  scope = '',
  now = Date.now,
} = {}) {
  const snapshot = await store.readLatest()
  if (!snapshot || snapshot.availability !== 'READY') {
    return {
      ok: false,
      errorCode: 'NO_RECALL_SNAPSHOT',
      error: '请先运行全市场召回',
    }
  }
  const previous = await store.readNextDaySelection(scope)
  const selection = normalizeNextDaySelection({
    codes,
    snapshot,
    previous,
    now: Number(now()) || Date.now(),
  })
  await store.saveNextDaySelection(selection, scope)
  return { ok: true, nextDaySelection: selection }
}

export async function handleNextDayRecalculation({
  store = stockPickStore,
  generate = generateStockPickAgentSelection,
  fetchQuoteList = fetchQuotes,
  codes = [],
  trigger = 'MANUAL_RECHECK',
  scope = '',
  now = Date.now,
} = {}) {
  const timestamp = Number(now()) || Date.now()
  const saved = await store.readNextDaySelection(scope)
  const savedCodes = (saved?.items || []).map((item) => item.code)
  let targetCodes = []
  const quoteTradeDates = new Map()
  if (trigger === 'FIRST_QUOTE') {
    const quotes = await fetchQuoteList(savedCodes, { now: timestamp })
    targetCodes = firstQuoteRecalculationCodes(saved, quotes)
    for (const quote of quotes) {
      const code = String(quote?.code || '')
      if (!targetCodes.includes(code)) continue
      quoteTradeDates.set(code, String(quote?.tradeDate || ''))
    }
    if (!targetCodes.length) {
      return {
        ok: true,
        skipped: true,
        reasonCode: 'FIRST_QUOTE_NOT_READY',
        nextDaySelection: saved || null,
      }
    }
  } else {
    const allowed = new Set(savedCodes)
    targetCodes = (Array.isArray(codes) ? codes : [])
      .map((code) => String(code || ''))
      .filter((code) => allowed.has(code))
    if (!targetCodes.length) {
      return {
        ok: false,
        errorCode: 'NEXT_DAY_SELECTION_REQUIRED',
        error: '请先人工勾选并保存次日关注股票',
      }
    }
  }

  const result = await handleStockPickAgent({
    store,
    generate,
    now,
    mode: STOCK_PICK_MODE.NEXT_DAY,
    codes: targetCodes,
    trigger,
    scope,
  })
  if (trigger === 'FIRST_QUOTE' && quoteTradeDates.size) {
    const nextSelection = {
      ...saved,
      items: (saved?.items || []).map((item) => (
        quoteTradeDates.has(String(item?.code || ''))
          ? {
              ...item,
              lastAutoTradeDate: quoteTradeDates.get(String(item.code)),
            }
          : item
      )),
      autoRecalculatedAt: timestamp,
    }
    await store.saveNextDaySelection(nextSelection, scope)
    result.nextDaySelection = nextSelection
  }
  return result
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    let authentication = { ok: false, account: null }
    try {
      authentication = await authenticateAccountRequest(req, {
        includeAdviceRuntime: false,
      })
    } catch {
      authentication = { ok: false, account: null }
    }
    const scope = authentication.ok
      ? (authentication.account?.nick || 'trusted')
      : ''
    const [snapshot, progress, nextDaySelection, agentEntries] = await Promise.all([
      stockPickStore.readLatest(),
      stockPickStore.readProgress(),
      scope ? stockPickStore.readNextDaySelection(scope) : null,
      scope
        ? Promise.all(modeIds.map(async (mode) => [
            mode,
            await stockPickStore.readAgent(mode, scope),
            await stockPickStore.readAgentProgress(mode, scope),
          ]))
        : modeIds.map((mode) => [mode, null, null]),
    ])
    const agents = Object.fromEntries(
      agentEntries.map(([mode, agent]) => [mode, agent || null]),
    )
    const agentProgress = Object.fromEntries(
      agentEntries.map(([mode, , itemProgress]) => [
        mode,
        itemProgress || null,
      ]),
    )
    const agent = agents[STOCK_PICK_MODE.INTRADAY]
    const references = agent
      && !(agent.conclusion === 'SELECT' && agent.selections?.length)
      && snapshot?.availability === 'READY'
      ? topStockPickReferences(snapshot)
      : []
    return reply(res, 200, {
      ok: true,
      snapshot: snapshot || null,
      progress: progress || null,
      agent: agent || null,
      agents,
      agentProgress,
      nextDaySelection: nextDaySelection || null,
      references,
    })
  }

  if (req.method !== 'POST') {
    return reply(res, 405, {
      ok: false,
      error: 'method not allowed',
      errorCode: 'METHOD_NOT_ALLOWED',
    })
  }

  let authentication
  try {
    authentication = await authenticateAccountRequest(req, {
      includeAdviceRuntime: false,
    })
  } catch {
    // 存储/鉴权后端异常按未授权处理，不暴露为 500。
    authentication = { ok: false, error: '账号鉴权失败' }
  }
  if (!authentication.ok) {
    return reply(res, 401, {
      ok: false,
      error: authentication.error || '请先登录',
      errorCode: 'UNAUTHORIZED',
    })
  }

  let body
  try {
    body = typeof req.body === 'string'
      ? JSON.parse(req.body || '{}')
      : (req.body || {})
  } catch {
    return reply(res, 400, {
      ok: false,
      error: '请求格式无效',
      errorCode: 'INVALID_JSON',
    })
  }

  if (![
    'run',
    'agent',
    'save_next_day_selection',
    'recalculate_next_day',
  ].includes(body.action)) {
    return reply(res, 422, {
      ok: false,
      error: '选股操作无效',
      errorCode: 'INVALID_ACTION',
    })
  }

  try {
    const scope = authentication.account?.nick || 'trusted'
    let result
    if (body.action === 'agent') {
      result = await handleStockPickAgent({
        mode: body.mode,
        trigger: 'INITIAL',
        scope,
      })
    } else if (body.action === 'save_next_day_selection') {
      result = await handleNextDaySelection({
        codes: body.codes,
        scope,
      })
    } else if (body.action === 'recalculate_next_day') {
      result = await handleNextDayRecalculation({
        codes: body.codes,
        trigger: body.trigger === 'FIRST_QUOTE'
          ? 'FIRST_QUOTE'
          : 'MANUAL_RECHECK',
        scope,
      })
    } else {
      result = await handleStockPickRun()
    }
    return reply(res, 200, result)
  } catch (error) {
    console.error(
      '[stock_pick] action failed',
      body.action,
      error?.code || error?.name || error?.message,
    )
    return reply(res, 500, {
      ok: false,
      error: '选股服务失败',
      errorCode: 'STOCK_PICK_FAILED',
    })
  }
}
