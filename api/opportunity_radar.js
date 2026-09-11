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
  readPreCatalystState,
} from './pre_catalyst.js'
import {
  opportunityRadarBaselineStore,
} from './_opportunity_radar_baseline_store.js'
import {
  readSectorForecastBootstrap,
} from './sector_forecast.js'
import {
  readTailPickState,
} from './tail_pick.js'
import { fetchQuotes } from './quote.js'
import { buildAccountRiskContext, allocateOpportunityBudget, accountRiskCodes } from '../shared/accountRiskBudget.js'
import { analyzeOpportunityPortfolio } from '../shared/opportunityPortfolio.js'
import {
  opportunityTrainingStatusStore,
} from './_opportunity_training_status.js'

const SOURCE_READ_TIMEOUT_MS = 15_000

function message(reason) {
  return String(reason?.message || reason || '').slice(0, 180)
}

function withTimeout(promise, label, timeoutMs = SOURCE_READ_TIMEOUT_MS) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label}超时`)),
        timeoutMs,
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
  readPreCatalyst = () => readPreCatalystState(),
  readBaseline = () => opportunityRadarBaselineStore.readBaseline(),
  readTrainingStatus = () =>
    opportunityTrainingStatusStore.readStatus(),
  accountData = null,
  readQuotes = fetchQuotes,
  now = Date.now(),
} = {}) {
  const codes = accountRiskCodes(accountData)
  const riskPromise = accountData
    ? withTimeout(Promise.resolve().then(() => readQuotes(codes)), '持仓报价', 5000)
      .catch(() => [])
      .then((quotes) => buildAccountRiskContext(
        accountData,
        Object.fromEntries((Array.isArray(quotes) ? quotes : []).map((quote) => [quote.code, quote])),
        now,
      ))
    : Promise.resolve(null)
  const [
    sectorResult,
    formulaResult,
    tailResult,
    preCatalystResult,
    baselineResult,
    trainingStatusResult,
  ] =
    await Promise.allSettled([
      withTimeout(Promise.resolve().then(readSector), '板块结果读取'),
      withTimeout(Promise.resolve().then(readFormula), '公式结果读取'),
      withTimeout(Promise.resolve().then(readTail), '尾盘结果读取'),
      withTimeout(
        Promise.resolve().then(readPreCatalyst),
        '预催化结果读取',
      ),
      withTimeout(
        Promise.resolve().then(readBaseline),
        '统计基线读取',
      ),
      withTimeout(
        Promise.resolve().then(readTrainingStatus),
        '决策模型训练状态读取',
        5000,
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
    preCatalyst: preCatalystResult.status === 'rejected'
      ? '预催化结果读取失败'
      : '',
  }
  const trainingStatus = settledValue(trainingStatusResult, null)
  const radar = buildOpportunityRadar({
    sector: settledValue(sectorResult, {}),
    formula: settledValue(formulaResult, {}),
    tail: settledValue(tailResult, null),
    preCatalyst: settledValue(preCatalystResult, null),
    sourceErrors,
    activeModelVersion:
      trainingStatus?.enabled === true
        ? trainingStatus.modelVersion
        : '',
    now,
  })
  const accountRisk = await riskPromise
  if (accountRisk) {
    radar.portfolios = Object.fromEntries(Object.entries(radar.lanes).map(
      ([lane, rows]) => [lane, allocateOpportunityBudget(
        analyzeOpportunityPortfolio({
          rows, holdings: [...accountRisk.exposures, ...accountRisk.reservedExposures],
        }),
        accountRisk,
      )],
    ))
  }
  return {
    ok: true,
    partial: Object.values(sourceErrors).some(Boolean),
    baseline: settledValue(baselineResult, null),
    trainingStatus,
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
    return reply(res, 200, await readOpportunityRadarSnapshot({
      accountData: authentication.account.data,
    }))
  } catch (error) {
    return reply(res, 500, {
      ok: false,
      error: message(error) || '机会雷达暂时不可用',
      errorCode: 'OPPORTUNITY_RADAR_FAILED',
    })
  }
}
