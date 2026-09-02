import {
  normalizeOpportunityScoreResponse,
  unavailableOpportunityScore,
} from '../shared/opportunityScoreContract.js'

const REQUEST_BATCH_SIZE = 80
const MAX_SHADOW_ITEMS = 240

function fallbackMap(inputs, reason) {
  return new Map(inputs.map((input) => [
    input.code,
    unavailableOpportunityScore(input, reason),
  ]))
}

async function fetchBatch(inputs, {
  base,
  key,
  fetchImpl,
  timeoutMs,
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/opportunity-score`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
      },
      body: JSON.stringify({ items: inputs }),
    })
    if (!response.ok) return fallbackMap(inputs, 'SERVICE_UNAVAILABLE')
    const payload = await response.json()
    if (!payload?.ok || !Array.isArray(payload.predictions)) {
      return fallbackMap(inputs, 'INVALID_RESPONSE')
    }
    const received = new Map(
      payload.predictions.map((item) => [String(item?.code || ''), item]),
    )
    return new Map(inputs.map((input) => {
      const raw = received.get(input.code)
      if (!raw) {
        return [
          input.code,
          unavailableOpportunityScore(input, 'MISSING_RESPONSE'),
        ]
      }
      try {
        return [
          input.code,
          normalizeOpportunityScoreResponse(raw, input),
        ]
      } catch {
        return [
          input.code,
          unavailableOpportunityScore(input, 'INVALID_RESPONSE'),
        ]
      }
    }))
  } catch {
    return fallbackMap(inputs, 'SERVICE_UNAVAILABLE')
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchOpportunityScores(inputs, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 2000,
} = {}) {
  const values = (Array.isArray(inputs) ? inputs : [])
    .filter((item) => /^\d{6}$/.test(String(item?.code || '')))
  if (!values.length) return new Map()
  const base = String(env.QUANT_URL || '').trim().replace(/\/+$/, '')
  if (!base) return fallbackMap(values, 'SERVICE_NOT_CONFIGURED')
  const selected = values.slice(0, MAX_SHADOW_ITEMS)
  const batches = []
  for (
    let index = 0;
    index < selected.length;
    index += REQUEST_BATCH_SIZE
  ) {
    batches.push(selected.slice(index, index + REQUEST_BATCH_SIZE))
  }
  const results = await Promise.all(batches.map((items) =>
    fetchBatch(items, {
      base,
      key: env.QUANT_KEY,
      fetchImpl,
      timeoutMs,
    }),
  ))
  const scores = fallbackMap(values, 'DEFERRED')
  for (const result of results) {
    for (const [code, score] of result) scores.set(code, score)
  }
  return scores
}
