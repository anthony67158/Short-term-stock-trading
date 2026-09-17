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
  unavailableStockPickSnapshot,
} from '../shared/stockPick.js'
import {
  topStockPickReferences,
  unavailableStockPickAgentSelection,
} from '../shared/stockPickAgent.js'
import { randomUUID } from 'node:crypto'

const runFlights = new Map()

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
} = {}) {
  const snapshot = await store.readLatest()
  if (!snapshot || snapshot.availability !== 'READY' || !snapshot.candidates?.length) {
    const selection = unavailableStockPickAgentSelection({
      reasonCode: 'NO_RECALL_SNAPSHOT',
      reason: '请先运行全市场召回',
      now: Number(now()) || Date.now(),
    })
    await store.saveAgent(selection)
    return { ok: true, selection, references: [] }
  }
  const selection = await generate({
    snapshot,
    agentRunId: randomUUID(),
    now: Number(now()) || Date.now(),
  })
  await store.saveAgent(selection)
  // Agent 未选/不可用时，附 Top 候选供人工参考（明确标注未经 Agent 精选）。
  const references = selection.conclusion === 'SELECT' && selection.selections.length
    ? []
    : topStockPickReferences(snapshot)
  return { ok: true, selection, references }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'GET') {
    const [snapshot, progress, agent] = await Promise.all([
      stockPickStore.readLatest(),
      stockPickStore.readProgress(),
      stockPickStore.readAgent(),
    ])
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

  const authentication = await authenticateAccountRequest(req, {
    includeAdviceRuntime: false,
  })
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

  if (!['run', 'agent'].includes(body.action)) {
    return reply(res, 422, {
      ok: false,
      error: '选股操作无效',
      errorCode: 'INVALID_ACTION',
    })
  }

  try {
    const result = body.action === 'agent'
      ? await handleStockPickAgent()
      : await handleStockPickRun()
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
