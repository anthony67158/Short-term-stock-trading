import OSS from 'ali-oss'
import { fetchFiveMinuteBars } from './_v2_quant.js'
import {
  aggregateV21Accuracy,
  settleV21Prediction,
} from '../shared/v21Accuracy.js'

const LAB_BUCKET = 'stock-quant-lab-1730034925594178'
const PREDICTION_PREFIX = 'shadow/v2.1-intraday/'
const ACCURACY_KEY = 'shadow/v2.1-intraday/accuracy.json'

function labClient(env = process.env) {
  const bucket = env.V2_LAB_OSS_BUCKET || LAB_BUCKET
  if (
    bucket !== LAB_BUCKET
    || !env.OSS_ACCESS_KEY_ID
    || !env.OSS_ACCESS_KEY_SECRET
  ) throw new Error('V2.1效果存储未配置')
  return new OSS({
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    bucket,
    endpoint: env.V2_LAB_OSS_ENDPOINT
      || env.OSS_ENDPOINT
      || 'https://oss-cn-hangzhou-internal.aliyuncs.com',
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

async function listPrefixKeys(client, prefix) {
  const keys = []
  let marker = null
  do {
    const result = await client.list({
      prefix,
      marker,
      'max-keys': 1000,
    })
    for (const item of result.objects || []) {
      if (
        item.name !== ACCURACY_KEY
        && item.name.endsWith('.json')
      ) keys.push(item.name)
    }
    marker = result.nextMarker || null
  } while (marker)
  return keys
}

function dateKeys(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  const values = []
  if (
    !Number.isFinite(start.getTime())
    || !Number.isFinite(end.getTime())
    || start > end
  ) return values
  for (
    let value = start.getTime();
    value <= end.getTime();
    value += 24 * 3600 * 1000
  ) values.push(new Date(value).toISOString().slice(0, 10))
  return values
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

export async function loadV21Accuracy({
  client = labClient(),
} = {}) {
  return await readJson(client, ACCURACY_KEY) || {
    schemaVersion: 1,
    modelVersion: 'v2.1-intraday',
    updatedAt: 0,
    total: 0,
    heads: {
      next30m: { total: 0, correct: 0, accuracyPct: null },
      sessionClose: { total: 0, correct: 0, accuracyPct: null },
    },
    sessions: {},
    dates: {},
  }
}

export async function refreshV21Accuracy({
  client = labClient(),
  fetchBars = fetchFiveMinuteBars,
  now = Date.now(),
} = {}) {
  const from = new Date(now - 21 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10)
  const to = new Date(now).toISOString().slice(0, 10)
  const keys = (await mapWithConcurrency(
    dateKeys(from, to),
    4,
    (date) => listPrefixKeys(
      client,
      `${PREDICTION_PREFIX}${date}/`,
    ),
  )).flat()
  const records = (await mapWithConcurrency(
    keys,
    12,
    (key) => readJson(client, key).catch(() => null),
  )).filter(Boolean)
  const codes = [...new Set(
    records
      .map((record) => String(record?.code || '').slice(0, 6))
      .filter((code) => /^\d{6}$/.test(code)),
  )]
  const barsByCode = new Map()
  await mapWithConcurrency(codes, 5, async (code) => {
    try {
      barsByCode.set(code, await fetchBars(code, {
        limit: 1200,
        completedWindowOnly: false,
      }))
    } catch {
      barsByCode.set(code, [])
    }
  })
  const settled = records.map((record) =>
    settleV21Prediction(
      record,
      barsByCode.get(String(record?.code || '').slice(0, 6)) || [],
    )
  ).filter(Boolean)
  const accuracy = aggregateV21Accuracy(settled, now)
  await client.put(
    ACCURACY_KEY,
    Buffer.from(JSON.stringify(accuracy)),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    },
  )
  return accuracy
}
