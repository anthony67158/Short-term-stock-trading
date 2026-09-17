import {
  hasStorage,
  list,
  readJson,
} from './_blob.js'
import {
  listReports,
  readOpportunitySummary,
} from './quant_report.js'
import {
  buildModelTrainingSummary,
  normalizeLearningTrainingReport,
  normalizeLegacyTrainingReport,
} from '../shared/modelTraining.js'
import {
  preflight,
  sendJson,
} from './_lib.js'

const LEARNING_RUN_PREFIX = 'learning/v1/training-runs/'

function safeLimit(value) {
  return Math.min(300, Math.max(1, Math.trunc(Number(value) || 100)))
}

async function readInBatches(blobs, reader, batchSize = 8) {
  const output = []
  for (let offset = 0; offset < blobs.length; offset += batchSize) {
    const batch = await Promise.all(blobs
      .slice(offset, offset + batchSize)
      .map(async (blob) => ({
        blob,
        value: await reader(blob).catch(() => null),
      })))
    output.push(...batch)
  }
  return output
}

export async function listLearningTrainingRuns(
  limit,
  storage = { list, readJson },
) {
  const maximum = safeLimit(limit)
  const { blobs = [] } = await storage.list({
    prefix: LEARNING_RUN_PREFIX,
    limit: 3000,
  })
  const reports = blobs
    .filter((blob) => String(blob.pathname || '').endsWith('/report.json'))
    .sort((left, right) =>
      new Date(right.uploadedAt || 0).getTime()
      - new Date(left.uploadedAt || 0).getTime()
    )
    .slice(0, maximum)
  const values = await readInBatches(reports, storage.readJson)
  return values.flatMap(({ blob, value }) =>
    normalizeLearningTrainingReport(value, {
      pathname: blob.pathname,
      uploadedAt: blob.uploadedAt,
    })
  )
}

export async function collectModelTraining({
  limit = 100,
  storage = { list, readJson },
} = {}) {
  const maximum = safeLimit(limit)
  const [learningResult, legacyResult, activeResult] =
    await Promise.allSettled([
      listLearningTrainingRuns(maximum, storage),
      listReports(maximum, storage, 'all'),
      readOpportunitySummary(storage.readJson),
    ])
  const warnings = []
  if (learningResult.status === 'rejected') {
    warnings.push('增量学习报告暂时不可用')
  }
  if (legacyResult.status === 'rejected') {
    warnings.push('历史模型报告暂时不可用')
  }
  if (activeResult.status === 'rejected') {
    warnings.push('生产模型状态暂时不可用')
  }
  const learningRuns = learningResult.status === 'fulfilled'
    ? learningResult.value
    : []
  const legacyRuns = legacyResult.status === 'fulfilled'
    ? legacyResult.value.map((report) =>
        normalizeLegacyTrainingReport(report, report.id)
      ).filter(Boolean)
    : []
  const runs = [...learningRuns, ...legacyRuns]
    .sort((left, right) => Number(right.runAt || 0) - Number(left.runAt || 0))
    .slice(0, maximum)
  const active = activeResult.status === 'fulfilled'
    ? activeResult.value
    : null
  return {
    schemaVersion: 'model-training-center.v1',
    generatedAt: Date.now(),
    models: buildModelTrainingSummary(runs, active),
    runs,
    active,
    warnings,
    sources: {
      dailyLearning: learningResult.status === 'fulfilled',
      legacyReports: legacyResult.status === 'fulfilled',
      productionStatus: activeResult.status === 'fulfilled',
    },
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  if (req.method !== 'GET') {
    return sendJson(res, { ok: false, error: 'method not allowed' }, {
      status: 405,
      cache: 0,
    })
  }
  if (!hasStorage()) {
    return sendJson(res, { ok: false, error: '云端存储未配置' }, {
      status: 503,
      cache: 0,
    })
  }
  try {
    const result = await collectModelTraining({
      limit: req.query?.limit,
    })
    return sendJson(res, { ok: true, ...result }, { cache: 0 })
  } catch (error) {
    console.error('[model-training] read failed', error?.message || error)
    return sendJson(res, {
      ok: false,
      error: '模型训练记录读取失败，请稍后重试',
    }, { status: 503, cache: 0 })
  }
}
