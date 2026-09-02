import {
  buildOpportunityRadar,
} from '../shared/opportunityRadar.js'
import {
  authenticateAccountRequest,
} from './_account_auth.js'
import {
  applyCors,
  preflight,
} from './_lib.js'
import {
  readFormulaSelectionState,
} from './formula_selection.js'
import {
  opportunityRadarBaselineStore,
} from './_opportunity_radar_baseline_store.js'
import {
  readSectorForecastBootstrap,
} from './sector_forecast.js'
import {
  readTailPickState,
} from './tail_pick.js'

const SOURCE_READ_TIMEOUT_MS = 15_000

function message(reason) {
  return String(reason?.message || reason || '').slice(0, 180)
}

function withTimeout(promise, label) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label}超时`)),
        SOURCE_READ_TIMEOUT_MS,
      )
    }),
  ]).finally(() => clearTimeout(timeout))
}

function settledValue(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback
}

export async function readOpportunityRadarSnapshot({
  readSector = () => readSectorForecastBootstrap({
    historyLimit: 8,
  }),
  readFormula = () => readFormulaSelectionState({
    tailReader: async () => null,
  }),
  readTail = () => readTailPickState(),
  readBaseline = () => opportunityRadarBaselineStore.readBaseline(),
  now = Date.now(),
} = {}) {
  const [sectorResult, formulaResult, tailResult, baselineResult] =
    await Promise.allSettled([
      withTimeout(Promise.resolve().then(readSector), '板块结果读取'),
      withTimeout(Promise.resolve().then(readFormula), '公式结果读取'),
      withTimeout(Promise.resolve().then(readTail), '尾盘结果读取'),
      withTimeout(
        Promise.resolve().then(readBaseline),
        '统计基线读取',
      ),
    ])
  const sourceErrors = {
    sector: sectorResult.status === 'rejected'
      ? '板块结果读取失败'
      : '',
    formula: formulaResult.status === 'rejected'
      ? '公式结果读取失败'
      : '',
    tail: tailResult.status === 'rejected'
      ? '尾盘结果读取失败'
      : '',
  }
  const radar = buildOpportunityRadar({
    sector: settledValue(sectorResult, {}),
    formula: settledValue(formulaResult, {}),
    tail: settledValue(tailResult, null),
    sourceErrors,
    now,
  })
  return {
    ok: true,
    partial: Object.values(sourceErrors).some(Boolean),
    baseline: settledValue(baselineResult, null),
    ...radar,
  }
}

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    return reply(res, 405, {
      ok: false,
      error: 'method not allowed',
      errorCode: 'METHOD_NOT_ALLOWED',
    })
  }

  try {
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
    return reply(res, 200, await readOpportunityRadarSnapshot())
  } catch (error) {
    return reply(res, 500, {
      ok: false,
      error: message(error) || '机会雷达暂时不可用',
      errorCode: 'OPPORTUNITY_RADAR_FAILED',
    })
  }
}
