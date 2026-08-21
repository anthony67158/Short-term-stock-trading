import {
  mergeSectorForecastExplanation,
} from '../shared/sectorForecast.js'
import {
  normalizeSectorForecastProgress,
} from '../shared/sectorForecastProgress.js'
import {
  beijingDayKey,
  beijingDate,
  isContinuousTrading,
} from '../shared/tradingCalendar.js'
import {
  authorizePaidRequest,
  authenticateAccountRequest,
  isRuntimeConfigAdmin,
} from './_account_auth.js'
import { applyCors, preflight } from './_lib.js'
import {
  buildSectorForecastSnapshot,
  collectSectorForecastData,
} from './_sector_forecast_data.js'
import {
  enrichSectorForecastSnapshot,
} from './_sector_forecast_llm.js'
import {
  fetchSectorQuantPredictions,
} from './_sector_quant.js'
import {
  dueSectorForecastSession,
  sectorForecastIntradaySlot,
  sectorForecastMarketPhase,
  sectorForecastRunKey,
  sectorForecastStore,
} from './_sector_forecast_store.js'

const generationFlights = new Map()

function normalizedSession(value) {
  return ['close', 'overnight', 'intraday'].includes(value)
    ? value
    : 'close'
}

function beijingTimeLabel(timestamp = Date.now()) {
  const date = beijingDate(timestamp)
  return `${beijingDayKey(timestamp)} `
    + `${String(date.getHours()).padStart(2, '0')}:`
    + String(date.getMinutes()).padStart(2, '0')
}

function finiteOptional(value) {
  return value !== null
    && value !== undefined
    && value !== ''
    && Number.isFinite(Number(value))
}

function quantPriorsFromSnapshot(snapshot) {
  return new Map(
    (Array.isArray(snapshot?.sectors) ? snapshot.sectors : [])
      .filter((item) =>
        item?.code
        && (
          finiteOptional(item.forecast?.next?.probability)
          || finiteOptional(item.forecast?.week?.probability)
        )
      )
      .map((item) => [String(item.code), {
        nextProbability: item.forecast?.next?.probability,
        weekProbability: item.forecast?.week?.probability,
        drawdownEstimate: item.forecast?.week?.drawdownEstimate,
      }]),
  )
}

function mergeIntradayContext(snapshot, base, now = Date.now()) {
  const byCode = new Map(
    (Array.isArray(base?.sectors) ? base.sectors : [])
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item]),
  )
  return {
    ...snapshot,
    session: 'intraday',
    baseSession: base?.session || null,
    baseGeneratedAt: Number(base?.generatedAt) || null,
    generatedAt: Number(now) || Date.now(),
    rankingGeneratedAt: Number(now) || Date.now(),
    dataAsOf: beijingTimeLabel(now),
    intradayEstimate: true,
    model: {
      ...snapshot.model,
      quant: quantPriorsFromSnapshot(base).size
        ? 'lightgbm-prior'
        : 'unavailable',
    },
    sectors: snapshot.sectors.map((sector) => {
      const formal = byCode.get(String(sector.code))
      return {
        ...sector,
        formalRank: formal?.rank || null,
        formalWeekRank: formal?.weekRank || null,
        formalActionability: formal?.actionability || null,
        explanation: {
          ...(formal?.explanation || {}),
          whyNow: (sector.reasons || []).join('；')
            || `盘中资金与成分股结构支持当前${sector.rank}名。`,
          risks: sector.risks?.length
            ? sector.risks
            : (formal?.explanation?.risks || formal?.risks || []),
        },
      }
    }),
  }
}

function reply(res, status, body) {
  res.status(status)
  return res.send(JSON.stringify(body))
}

export function mergeOvernightEvidence(
  base,
  explanations = [],
  now = Date.now(),
) {
  if (!base || !Array.isArray(base.sectors)) {
    throw new Error('缺少可复核的收盘正式版')
  }
  const byCode = new Map(
    (Array.isArray(explanations) ? explanations : [])
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item]),
  )
  return {
    ...base,
    session: 'overnight',
    baseSession: base.session === 'overnight'
      ? (base.baseSession || 'close')
      : (base.session || 'close'),
    evidenceUpdatedAt: Number(now) || Date.now(),
    sectors: base.sectors.map((sector) =>
      mergeSectorForecastExplanation(
        sector,
        byCode.get(String(sector.code))?.explanation
          || byCode.get(String(sector.code))
          || {},
      )
    ),
  }
}

export function runSectorForecastGeneration({
  store = sectorForecastStore,
  session = 'close',
  signalDate,
  runDate = signalDate,
  runSlot = '',
  generate,
  force = false,
  now = Date.now,
} = {}) {
  const runSession = normalizedSession(session)
  const key = sectorForecastRunKey(runDate, runSession, runSlot)
  if (!key) return Promise.reject(new Error('板块前瞻任务日期无效'))
  if (typeof generate !== 'function') {
    return Promise.reject(new Error('板块前瞻生成器未配置'))
  }
  const existing = generationFlights.get(key)
  if (existing) return existing

  const task = (async () => {
    const previousTask = await store.readTask()
    const observedAt = Number(now()) || Date.now()
    if (
      previousTask.active?.status === 'running'
      && Number(previousTask.active.startedAt) > 0
      && observedAt - Number(previousTask.active.startedAt)
        < 15 * 60 * 1000
    ) {
      return {
        ok: true,
        skipped: true,
        reason: 'active-generation',
        snapshot: runSession === 'intraday'
          ? await store.readIntraday()
          : await store.readLatest(),
      }
    }
    if (!force && previousTask.completed?.[key]) {
      const snapshot = runSession === 'intraday'
        ? await store.readIntraday()
        : await store.readHistorySnapshot(signalDate, runSession)
      return {
        ok: true,
        skipped: true,
        snapshot,
      }
    }
    const claim = !force && typeof store.claimRun === 'function'
      ? await store.claimRun(key, Number(now()) || Date.now())
      : null
    if (claim && !claim.acquired) {
      return {
        ok: true,
        skipped: true,
        reason: 'already-running',
        snapshot: await store.readLatest(),
      }
    }
    const startedAt = Number(now()) || Date.now()
    const baseActive = {
      key,
      runDate,
      signalDate,
      session: runSession,
      status: 'running',
      startedAt,
    }
    await store.saveTask({
      ...previousTask,
      active: {
        ...baseActive,
        progress: normalizeSectorForecastProgress({
          stage: 'preparing',
          percent: 3,
          message: '正在初始化板块前瞻任务',
        }, startedAt),
      },
      updatedAt: startedAt,
    })
    const onProgress = async (progress) => {
      const currentTask = await store.readTask()
      if (
        currentTask.active?.key
        && currentTask.active.key !== key
      ) return
      const updatedAt = Number(now()) || Date.now()
      await store.saveTask({
        ...currentTask,
        active: {
          ...baseActive,
          ...(currentTask.active || {}),
          progress: normalizeSectorForecastProgress(
            progress,
            updatedAt,
          ),
        },
        updatedAt,
      })
    }
    try {
      const generated = await generate({
        signalDate,
        session: runSession,
        onProgress,
      })
      if (
        !generated
        || !Array.isArray(generated.sectors)
        || generated.sectors.length === 0
      ) {
        throw new Error(
          '没有有效板块数据，已保留上一版结果；盘前请执行证据复核，开盘后再刷新实时排名',
        )
      }
      const snapshot = {
        ...generated,
        signalDate: generated.signalDate || signalDate,
        session: runSession,
        generatedAt: Number(generated.generatedAt) || startedAt,
      }
      await onProgress({
        stage: 'saving',
        percent: 94,
        message: runSession === 'overnight'
          ? '正在保存盘前证据复核版'
          : runSession === 'intraday'
            ? '正在保存盘中动态版'
            : '正在保存收盘正式版',
      })
      await store.saveSnapshot(snapshot)
      const currentTask = await store.readTask()
      await store.saveTask({
        ...currentTask,
        active: null,
        completed: {
          ...(currentTask.completed || {}),
          [key]: true,
        },
        latest: {
          key,
          runDate,
          signalDate: snapshot.signalDate,
          session: runSession,
          status: 'done',
          finishedAt: Number(now()) || Date.now(),
          progress: {
            stage: 'done',
            percent: 100,
            message: '板块前瞻生成完成',
          },
        },
        updatedAt: Number(now()) || Date.now(),
      })
      return { ok: true, skipped: false, snapshot }
    } catch (error) {
      if (claim?.acquired && typeof store.releaseRun === 'function') {
        await store.releaseRun(claim).catch(() => {})
      }
      const currentTask = await store.readTask()
      await store.saveTask({
        ...currentTask,
        active: null,
        latest: {
          key,
          runDate,
          signalDate,
          session: runSession,
          status: 'failed',
          finishedAt: Number(now()) || Date.now(),
          error: String(error?.message || error).slice(0, 240),
          progress: {
            ...(currentTask.active?.progress || {}),
            stage: 'failed',
            message: '板块前瞻生成失败',
          },
        },
        updatedAt: Number(now()) || Date.now(),
      })
      throw error
    }
  })()
  generationFlights.set(key, task)
  task.finally(() => {
    if (generationFlights.get(key) === task) generationFlights.delete(key)
  }).catch(() => {})
  return task
}

export async function generateSectorForecastSnapshot({
  signalDate,
  session = 'close',
  onProgress = async () => {},
} = {}, {
  store = sectorForecastStore,
  collect = collectSectorForecastData,
  fetchQuant = fetchSectorQuantPredictions,
  enrich = enrichSectorForecastSnapshot,
  now = Date.now,
} = {}) {
  if (session === 'overnight') {
    await onProgress({
      stage: 'loading',
      percent: 16,
      message: '正在读取收盘正式版排名',
    })
    const base = await store.readLatest()
    if (!base?.signalDate || !Array.isArray(base.sectors)) {
      throw new Error('没有可供盘前复核的收盘正式版')
    }
    const refreshed = await enrich({
      ...base,
      session: 'overnight',
    }, { now, onProgress })
    await onProgress({
      stage: 'finalizing',
      percent: 90,
      message: '正在合并隔夜证据且保持原排名',
    })
    return {
      ...mergeOvernightEvidence(
        base,
        refreshed.sectors,
        now(),
      ),
      generatedAt: Number(now()) || Date.now(),
      rankingGeneratedAt:
        Number(base.rankingGeneratedAt || base.generatedAt) || 0,
      search: refreshed.search,
      theories: refreshed.theories,
      explanationStatus: refreshed.explanationStatus,
    }
  }

  if (session === 'intraday') {
    await onProgress({
      stage: 'loading',
      percent: 12,
      message: '正在读取正式版量化先验与隔夜证据',
    })
    const base = await store.readLatest()
    await onProgress({
      stage: 'collecting',
      percent: 36,
      message: '正在采集实时板块资金与成分股扩散',
    })
    const collected = await collect()
    await onProgress({
      stage: 'scoring',
      percent: 72,
      message: '正在重算盘中可买性与反追高闸门',
    })
    const modeled = buildSectorForecastSnapshot({
      signalDate,
      generatedAt: now(),
      sectors: collected.sectors,
      histories: collected.histories,
      members: collected.members,
      quantPredictions: quantPriorsFromSnapshot(base),
    })
    await onProgress({
      stage: 'finalizing',
      percent: 90,
      message: '正在合并正式版证据并校验盘中结论',
    })
    return {
      ...mergeIntradayContext(modeled, base, now()),
      source: {
        sectorProvider: 'eastmoney-realtime',
        sectorUniverseCount: collected.allSectors.length,
        candidateCount: collected.sectors.length,
        historyDays: 30,
        memberVerified: true,
        quantPrior: base?.session || null,
      },
    }
  }

  await onProgress({
    stage: 'collecting',
    percent: 14,
    message: '正在采集全量概念、历史资金与真实成分股',
  })
  const collected = await collect()
  await onProgress({
    stage: 'scoring',
    percent: 36,
    message: '正在计算生命周期、扩散度与反追高评分',
  })
  const baseline = buildSectorForecastSnapshot({
    signalDate,
    generatedAt: now(),
    sectors: collected.sectors,
    histories: collected.histories,
    members: collected.members,
  })
  await onProgress({
    stage: 'quant',
    percent: 52,
    message: '正在调用LightGBM次日与一周双头模型',
  })
  const quantPredictions = await fetchQuant(baseline)
  const modeled = buildSectorForecastSnapshot({
    signalDate,
    generatedAt: now(),
    sectors: collected.sectors,
    histories: collected.histories,
    members: collected.members,
    quantPredictions,
  })
  const enriched = await enrich(modeled, { now, onProgress })
  await onProgress({
    stage: 'finalizing',
    percent: 90,
    message: '正在校验结论、证据和成分股',
  })
  return {
    ...enriched,
    rankingGeneratedAt: enriched.generatedAt,
    source: {
      sectorProvider: 'eastmoney',
      sectorUniverseCount: collected.allSectors.length,
      candidateCount: collected.sectors.length,
      historyDays: 30,
      memberVerified: true,
    },
  }
}

export async function runDueSectorForecast(timestamp = Date.now(), {
  store = sectorForecastStore,
  generate = (input) => generateSectorForecastSnapshot(
    input,
    { store },
  ),
  now = () => timestamp,
} = {}) {
  const [settings, task] = await Promise.all([
    store.readSettings(),
    store.readTask(),
  ])
  const session = dueSectorForecastSession(timestamp, settings, task)
  if (!session) {
    return {
      ok: true,
      skipped: true,
      reason: 'not-due-or-disabled',
    }
  }
  const runDate = beijingDayKey(timestamp)
  const runSlot = session === 'intraday'
    ? sectorForecastIntradaySlot(
      timestamp,
      settings.intradayIntervalMinutes,
    )
    : ''
  const latest = session === 'overnight'
    ? await store.readLatest()
    : null
  if (session === 'overnight' && !latest?.signalDate) {
    return {
      ok: true,
      skipped: true,
      reason: 'missing-close-snapshot',
    }
  }
  const signalDate = session === 'overnight'
    ? latest.signalDate
    : runDate
  return runSectorForecastGeneration({
    store,
    session,
    signalDate,
    runDate,
    runSlot,
    generate,
    now,
  })
}

export async function readSectorForecastBootstrap({
  store = sectorForecastStore,
  timestamp = Date.now(),
  historyLimit = 30,
} = {}) {
  const [latest, intraday, settings, task, history] =
    await Promise.all([
      store.readLatest(),
      store.readIntraday(),
      store.readSettings(),
      store.readTask(),
      store.readHistory(historyLimit),
    ])
  return {
    latest,
    intraday,
    settings,
    task,
    history,
    market: {
      intradayAvailable: isContinuousTrading(timestamp),
      phase: sectorForecastMarketPhase(timestamp),
      day: beijingDayKey(timestamp),
      asOf: timestamp,
    },
  }
}

async function readAuthentication(req) {
  const authentication = await authenticateAccountRequest(req)
  return authentication.ok && !authentication.trusted
    ? authentication
    : {
        ok: false,
        error: authentication.error || '请先登录',
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
    const action = String(
      body.action || req.query?.action || 'latest',
    )

    if (req.method === 'GET') {
      const authentication = await readAuthentication(req)
      if (!authentication.ok) {
        return reply(res, 401, { ok: false, error: authentication.error })
      }
      if (action === 'settings') {
        return reply(res, 200, {
          ok: true,
          settings: await sectorForecastStore.readSettings(),
        })
      }
      if (action === 'history') {
        return reply(res, 200, {
          ok: true,
          history: await sectorForecastStore.readHistory(req.query?.limit),
        })
      }
      if (action === 'status') {
        return reply(res, 200, {
          ok: true,
          task: await sectorForecastStore.readTask(),
        })
      }
      if (action === 'bootstrap') {
        return reply(res, 200, {
          ok: true,
          ...await readSectorForecastBootstrap({
            historyLimit: req.query?.limit,
          }),
        })
      }
      return reply(res, 200, {
        ok: true,
        latest: await sectorForecastStore.readLatest(),
        intraday: await sectorForecastStore.readIntraday(),
        settings: await sectorForecastStore.readSettings(),
        market: {
          intradayAvailable: isContinuousTrading(),
          phase: sectorForecastMarketPhase(),
          day: beijingDayKey(),
          asOf: Date.now(),
        },
      })
    }

    if (req.method !== 'POST') {
      return reply(res, 405, { ok: false, error: 'method not allowed' })
    }
    if (action === 'run_due') {
      const expected = String(process.env.CRON_KEY || '')
      const given = String(
        req.headers?.['x-cron-key']
        || body.key
        || req.query?.key
        || '',
      )
      if (!expected || given !== expected) {
        return reply(res, 401, { ok: false, error: 'unauthorized' })
      }
      return reply(res, 200, await runDueSectorForecast())
    }
    const paid = await authorizePaidRequest(req)
    if (!paid.ok || paid.trusted) {
      return reply(
        res,
        paid.error === '请先登录' ? 401 : 403,
        { ok: false, error: paid.error || '账号鉴权失败' },
      )
    }
    if (action === 'save_settings') {
      if (!isRuntimeConfigAdmin(paid.account)) {
        return reply(res, 403, {
          ok: false,
          error: '仅运行时配置管理员可修改板块前瞻设置',
        })
      }
      return reply(res, 200, {
        ok: true,
        settings: await sectorForecastStore.saveSettings(body.settings),
      })
    }
    if (action === 'generate') {
      const session = normalizedSession(body.session)
      if (session === 'intraday' && !isContinuousTrading()) {
        return reply(res, 409, {
          ok: false,
          error: '盘中动态版仅在交易日09:30-11:30、13:00-15:00可刷新',
        })
      }
      const runDate = beijingDayKey()
      const latest = session === 'overnight'
        ? await sectorForecastStore.readLatest()
        : null
      if (session === 'overnight' && !latest?.signalDate) {
        return reply(res, 409, {
          ok: false,
          error: '没有可供盘前复核的收盘正式版',
        })
      }
      const signalDate = session === 'overnight'
        ? latest.signalDate
        : runDate
      const result = await runSectorForecastGeneration({
        session,
        signalDate,
        runDate,
        runSlot: session === 'intraday'
          ? sectorForecastIntradaySlot(
            Date.now(),
            (await sectorForecastStore.readSettings())
              .intradayIntervalMinutes,
          )
          : '',
        force: true,
        generate: generateSectorForecastSnapshot,
      })
      return reply(res, 200, result)
    }
    return reply(res, 400, { ok: false, error: 'unknown action' })
  } catch (error) {
    return reply(res, 500, {
      ok: false,
      error: String(error?.message || error).slice(0, 240),
    })
  }
}
