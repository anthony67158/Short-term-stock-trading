import { applyCors, preflight } from './_lib.js'
import {
  isAccountActive,
  listAllAccounts,
  readAccount,
  writeAccount,
} from './account.js'
import {
  buildHoldPayload,
  computePortfolio,
} from './_portfolio.js'
import { marketTimeContext } from './_market_time.js'
import aiHandler from './ai.js'
import quoteHandler from './quote.js'
import { invoke, invokeSSE } from './cron_advice.js'
import { beijingDayKey } from '../shared/tradingCalendar.js'
import {
  claimReviewCodes,
  completeReviewClaim,
  failReviewClaim,
  mergeReviewAutoState,
} from '../shared/reviewSchedule.js'
import {
  addEvidenceSnapshot,
} from '../shared/evidenceSnapshot.js'
import { buildRealOutcomeLearning } from '../shared/realOutcomeLearning.js'

const REVIEW_CONCURRENCY = 2
const REVIEW_RUNTIME_BUDGET_MS = 300000

function beijingDayStart(timestamp = Date.now()) {
  const offset = 8 * 60 * 60 * 1000
  const day = 24 * 60 * 60 * 1000
  return Math.floor((timestamp + offset) / day) * day - offset
}

function todayTradesOf(data, code, now) {
  const start = beijingDayStart(now)
  const trades = []
  for (const record of (data.closed || [])) {
    if (String(record?.code) !== String(code)) continue
    const at = record.at || record.sellAt || record.buyAt || 0
    if (at < start) continue
    const type = record.type || record.kind
    if (type === 'BUY') {
      trades.push({ side: 'buy', price: record.price, qty: record.qty })
    } else if (type === 'SELL' || type === 'CLOSE') {
      trades.push({
        side: 'sell',
        price: record.sellPrice ?? record.price,
        qty: record.qty,
      })
    } else if (type === 'T') {
      trades.push({
        side: 't',
        buy: record.buyPrice,
        sell: record.sellPrice,
        qty: record.qty,
      })
    }
  }
  for (const holding of (data.holding || [])) {
    if (String(holding?.code) !== String(code)) continue
    for (const flow of (holding.tFlows || [])) {
      if ((flow.at || 0) >= start) {
        trades.push({
          side: flow.side,
          price: flow.price,
          qty: flow.qty,
        })
      }
    }
  }
  return trades.slice(0, 20)
}

function tradeHistoryOf(data, code) {
  return (data.closed || [])
    .filter((record) => String(record?.code) === String(code))
    .slice(0, 10)
    .map((record) => ({
      type: record.kind || record.type,
      buy: record.buyPrice != null ? +Number(record.buyPrice).toFixed(3) : null,
      sell: record.sellPrice != null ? +Number(record.sellPrice).toFixed(3) : null,
      qty: record.qty,
      pnl: record.netPnl != null ? +Number(record.netPnl).toFixed(0) : null,
    }))
}

function latestKnowledgeActionReviewOf(data, code) {
  return (data.decisionLog || [])
    .filter((event) =>
      event?.kind === 'execution'
      && String(event.code) === String(code)
      && event.knowledgeActionReview
    )
    .sort((left, right) => (right.at || 0) - (left.at || 0))[0]
    ?.knowledgeActionReview || null
}

export function buildReviewPayload(
  data,
  code,
  name,
  quoteMap,
  {
    now = Date.now(),
    session,
    nextTradeDay = marketTimeContext().nextTradingDayLabel,
  } = {},
) {
  const holding = data.holding || []
  const portfolio = computePortfolio(holding, quoteMap, data.account)
  const payload = buildHoldPayload(
    holding,
    code,
    name,
    portfolio,
    data.account,
    data.closed,
    nextTradeDay,
  )
  const price = Number(quoteMap?.[code]?.price)
  const pnlPct = price > 0 && Number(payload.holdCost) > 0
    ? +(((price - payload.holdCost) / payload.holdCost) * 100).toFixed(2)
    : null
  return {
    ...payload,
    session,
    hold: {
      cost: payload.holdCost,
      qty: payload.holdQty,
      pnlPct,
    },
    nextTradeDay,
    todayTrades: todayTradesOf(data, code, now),
    tradeHistory: tradeHistoryOf(data, code),
    knowledgeActionReview: latestKnowledgeActionReviewOf(data, code),
    quantModelVersion: data.settings?.quantModelVersion || 'default',
  }
}

async function fetchQuoteMap(codes) {
  const response = await invoke(quoteHandler, {
    method: 'GET',
    query: { codes: codes.join(',') },
  })
  return Object.fromEntries(
    ((response && response.list) || [])
      .filter((quote) => quote?.code)
      .map((quote) => [quote.code, quote]),
  )
}

export function reviewRecordFromAIResponse(
  payload,
  response,
  now = Date.now(),
) {
  return {
    code: payload.code,
    name: payload.name,
    at: now,
    result: response.result,
    ...(response.meta ? { meta: response.meta } : {}),
  }
}

async function generateReview(payload) {
  const response = await invokeSSE(aiHandler, {
    method: 'POST',
    body: {
      mode: 'review',
      payload,
      stream: true,
      runtimeBudgetMs: REVIEW_RUNTIME_BUDGET_MS,
    },
    timeoutMs: REVIEW_RUNTIME_BUDGET_MS + 30000,
    trustedQuantVersion: payload.quantModelVersion,
    trustedAccount: true,
  })
  if (!response?.ok || !response.result) {
    throw new Error(response?.error || '复盘生成失败')
  }
  return reviewRecordFromAIResponse(payload, response)
}

async function defaultWrite(account, options) {
  return writeAccount(account, undefined, options)
}

async function publishRuntime(working, readLatest, write) {
  const latest = (await readLatest(working.nick)) || working
  latest.data = latest.data || {}
  latest.data.reviewAuto = mergeReviewAutoState(
    latest.data.reviewAuto,
    working.data?.reviewAuto,
  )
  await write(latest, { history: false, verify: false })
  return latest
}

export async function processReviewAccount(
  initialAccount,
  {
    session,
    dayKey = beijingDayKey(),
    now = Date.now(),
  } = {},
  dependencies = {},
) {
  if (!isAccountActive(initialAccount)) {
    return { claimed: 0, ok: 0, fail: 0 }
  }
  const readLatest = dependencies.readLatest || readAccount
  const write = dependencies.write || defaultWrite
  const fetchQuotes = dependencies.fetchQuotes || fetchQuoteMap
  const generate = dependencies.generate || generateReview
  let working = structuredClone(initialAccount)
  const claimed = claimReviewCodes(working.data || (working.data = {}), {
    session,
    dayKey,
    now,
    limit: REVIEW_CONCURRENCY,
  })
  if (!claimed.length) return { claimed: 0, ok: 0, fail: 0 }

  working = await publishRuntime(working, readLatest, write)
  const quoteMap = await fetchQuotes(claimed.map((item) => item.code))
  const nextTradeDay = marketTimeContext().nextTradingDayLabel
  const outcomes = await Promise.all(claimed.map(async (item) => {
    try {
      const payload = buildReviewPayload(
        working.data,
        item.code,
        item.name,
        quoteMap,
        { now, session, nextTradeDay },
      )
      payload.accountRevision = Number(working.clientRevision) || null
      if (
        Number(payload.holdQty || 0) <= 0
        && Number(payload.openTNet || 0) >= 0
      ) {
        throw new Error('当前已无持仓')
      }
      return { item, review: await generate(payload) }
    } catch (error) {
      return { item, error }
    }
  }))

  const latest = (await readLatest(working.nick)) || working
  latest.data = latest.data || {}
  latest.data.reviewAuto = mergeReviewAutoState(
    latest.data.reviewAuto,
    working.data.reviewAuto,
  )
  let ok = 0
  let fail = 0
  for (const outcome of outcomes) {
    if (outcome.review) {
      completeReviewClaim(latest.data, {
        dayKey,
        session,
        code: outcome.item.code,
        review: outcome.review,
        now: Number(outcome.review.at) || Date.now(),
      })
      addEvidenceSnapshot(
        latest.data,
        outcome.review.meta?.evidenceSnapshot,
      )
      ok++
    } else {
      failReviewClaim(latest.data, {
        dayKey,
        session,
        code: outcome.item.code,
        error: outcome.error?.message || outcome.error,
        now,
      })
      fail++
    }
  }
  latest.data.realOutcomeLearning = buildRealOutcomeLearning(latest.data)
  await write(latest, { history: false, verify: true })
  return { claimed: claimed.length, ok, fail }
}

export function reviewResponse(session, totals) {
  return {
    ok: true,
    session,
    accounts: totals.accounts,
    claimed: totals.claimed,
    generated: totals.ok,
    failed: totals.fail,
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  const cronKey = process.env.CRON_KEY
  const supplied = req.headers['x-cron-key']
    || req.query?.key
    || req.body?.key
  if (!cronKey || supplied !== cronKey) {
    res.statusCode = 401
    return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
  }
  const session = String(req.body?.session || '')
  if (!['noon', 'close'].includes(session)) {
    res.statusCode = 400
    return res.end(JSON.stringify({ ok: false, error: 'invalid session' }))
  }

  try {
    const accounts = await listAllAccounts()
    const totals = { accounts: accounts.length, claimed: 0, ok: 0, fail: 0 }
    for (let index = 0; index < accounts.length; index += 2) {
      const batch = accounts.slice(index, index + 2)
      const results = await Promise.all(batch.map((account) =>
        processReviewAccount(account, { session })
          .catch(() => ({ claimed: 0, ok: 0, fail: 1 }))
      ))
      for (const result of results) {
        totals.claimed += result.claimed || 0
        totals.ok += result.ok || 0
        totals.fail += result.fail || 0
      }
    }
    return res.end(JSON.stringify(reviewResponse(session, totals)))
  } catch (error) {
    res.statusCode = 500
    return res.end(JSON.stringify({
      ok: false,
      error: String(error?.message || error),
    }))
  }
}
