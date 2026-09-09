import {
  authenticateAccountRequest,
} from './_account_auth.js'
import {
  applyCors,
  preflight,
} from './_lib.js'
import { fetchQuotes } from './quote.js'
import {
  readOpportunityRadarSnapshot,
} from './opportunity_radar.js'
import {
  buildPositionWorkbench,
} from '../shared/positionWorkbench.js'

const READ_TIMEOUT_MS = 20_000

function withTimeout(promise, timeoutMs = READ_TIMEOUT_MS) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('持仓工作台读取超时')),
        timeoutMs,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

function accountCodes(data = {}) {
  return [...new Set([
    ...(data.holding || []).map((item) => item?.code),
    ...(data.plan || []).map((item) => item?.code),
  ].filter((code) => /^\d{6}$/.test(String(code))))]
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    return reply(res, 405, {
      ok: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: '请求方法不支持',
      },
    })
  }

  try {
    const authentication = await authenticateAccountRequest(req)
    if (!authentication.ok || authentication.trusted) {
      return reply(res, 401, {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: authentication.error || '请先登录',
        },
      })
    }
    const book = authentication.account.data || {}
    const codes = accountCodes(book)
    const quotes = await withTimeout(
      codes.length ? fetchQuotes(codes) : Promise.resolve([]),
      7000,
    ).catch(() => [])
    const quoteMap = Object.fromEntries(
      quotes.filter((quote) => quote?.code)
        .map((quote) => [quote.code, quote]),
    )
    const opportunityRadar = await withTimeout(
      readOpportunityRadarSnapshot({
        accountData: book,
        readQuotes: async (requestedCodes) =>
          requestedCodes.map((code) => quoteMap[code]).filter(Boolean),
      }),
    ).catch(() => null)
    const workbench = buildPositionWorkbench({
      book,
      quoteMap,
      opportunityRadar,
    })
    return reply(res, 200, {
      ok: true,
      accountRevision: Number(authentication.account.clientRevision) || 0,
      partial: !opportunityRadar || quotes.length < codes.length,
      ...workbench,
    })
  } catch {
    return reply(res, 500, {
      ok: false,
      error: {
        code: 'POSITION_WORKBENCH_UNAVAILABLE',
        message: '持仓决策暂不可用',
      },
    })
  }
}
