import OSS from 'ali-oss'
import { fetchFiveMinuteBars } from './_v2_quant.js'
import {
  actualBarrierClass,
  aggregateV2Accuracy,
  mergeV2Accuracy,
  nextTradingSession,
} from '../shared/v2Accuracy.js'

const LAB_BUCKET = 'stock-quant-lab-1730034925594178'
const PREDICTION_PREFIX = 'shadow/predictions/'
const ACCURACY_KEY = 'shadow/accuracy/daily.json'

function labClient(env = process.env) {
  const bucket = env.V2_LAB_OSS_BUCKET || LAB_BUCKET
  const accessKeyId = env.OSS_ACCESS_KEY_ID
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET
  if (bucket !== LAB_BUCKET || !accessKeyId || !accessKeySecret) {
    throw new Error('V2效果存储未配置')
  }
  const endpoint = env.V2_LAB_OSS_ENDPOINT
    || env.OSS_ENDPOINT
    || 'https://oss-cn-hangzhou-internal.aliyuncs.com'
  return new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint,
    secure: true,
  })
}

async function readJson(client, key) {
  try {
    const result = await client.get(key)
    return JSON.parse(result.content.toString('utf8'))
  } catch (error) {
    if (error?.status === 404 || error?.code === 'NoSuchKey') return null
    throw error
  }
}

async function listKeys(client, prefix, limit = Number.POSITIVE_INFINITY) {
  const keys = []
  let marker = null
  do {
    const remaining = Number.isFinite(limit) ? limit - keys.length : 1000
    if (remaining <= 0) break
    const result = await client.list({
      prefix,
      marker,
      'max-keys': Math.min(1000, remaining),
    })
    for (const item of result.objects || []) {
      keys.push(item.name)
      if (keys.length >= limit) break
    }
    marker = result.nextMarker || null
  } while (marker && keys.length < limit)
  return keys
}

function dateKeys(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    return []
  }
  const dates = []
  for (
    let value = start.getTime();
    value <= end.getTime();
    value += 24 * 3600 * 1000
  ) {
    dates.push(new Date(value).toISOString().slice(0, 10))
  }
  return dates
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++
      output[index] = await worker(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  )
  return output
}

export async function listV2PredictionKeys(client, { from, to }) {
  const batches = await mapWithConcurrency(
    dateKeys(from, to),
    4,
    (date) => listKeys(client, `${PREDICTION_PREFIX}${date}/`),
  )
  return batches.flat()
}

export async function loadV2Accuracy({ client = labClient() } = {}) {
  return await readJson(client, ACCURACY_KEY) || {
    updatedAt: 0,
    overall: { total: 0, correct: 0, accuracyPct: null },
    days: [],
  }
}

export async function refreshV2Accuracy({
  client = labClient(),
  fetchBars = fetchFiveMinuteBars,
  now = Date.now(),
} = {}) {
  const cutoff = new Date(now - 21 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const today = new Date(now).toISOString().slice(0, 10)
  const keys = await listV2PredictionKeys(client, {
    from: cutoff,
    to: today,
  })
  const records = []
  for (let index = 0; index < keys.length; index += 20) {
    const batch = await Promise.all(
      keys.slice(index, index + 20).map((key) => readJson(client, key).catch(() => null)),
    )
    records.push(...batch.filter(Boolean))
  }
  const byCode = new Map()
  for (const record of records) {
    const code = String(record?.code || '').slice(0, 6)
    if (/^\d{6}$/.test(code)) byCode.set(code, null)
  }
  await mapWithConcurrency([...byCode.keys()], 5, async (code) => {
    try {
      byCode.set(code, await fetchBars(code, {
        limit: 1200,
        completedWindowOnly: false,
      }))
    } catch {
      byCode.set(code, [])
    }
  })
  const settled = records.map((record) => {
    const code = String(record?.code || '').slice(0, 6)
    const signalDate = String(record?.asOf || '').slice(0, 10)
    const session = nextTradingSession(byCode.get(code) || [], signalDate)
    return {
      requestId: record?.requestId,
      code: record?.code,
      asOf: record?.asOf,
      recordedAt: record?.recordedAt,
      predictedClass: record?.predictedClass,
      actualClass: actualBarrierClass(session),
    }
  })
  const fresh = aggregateV2Accuracy(settled)
  const existing = await loadV2Accuracy({ client })
  const accuracy = mergeV2Accuracy(existing, fresh, now)
  await client.put(
    ACCURACY_KEY,
    Buffer.from(JSON.stringify(accuracy)),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } },
  )
  return accuracy
}
