function probabilityPct(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const percent = number >= 0 && number <= 1 ? number * 100 : number
  return +Math.max(0, Math.min(100, percent)).toFixed(2)
}

function safeFactors(value = {}) {
  const output = {}
  for (const [key, raw] of Object.entries(value || {}).slice(0, 80)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key)) continue
    if (typeof raw === 'string') {
      output[key] = raw.slice(0, 32)
      continue
    }
    const number = Number(raw)
    if (Number.isFinite(number)) output[key] = number
  }
  return output
}

export async function fetchSectorQuantPredictions(snapshot, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 12000,
} = {}) {
  const base = String(env.QUANT_URL || '').trim().replace(/\/+$/, '')
  if (!base || !Array.isArray(snapshot?.sectors)) return new Map()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/sector-predict`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(env.QUANT_KEY ? { 'X-API-Key': env.QUANT_KEY } : {}),
      },
      body: JSON.stringify({
        signalDate: snapshot.signalDate,
        items: snapshot.sectors.map((item) => ({
          code: String(item.code || '').slice(0, 16),
          factors: safeFactors(item.factors),
        })),
      }),
    })
    if (!response.ok) return new Map()
    const payload = await response.json()
    if (!payload?.ok || !Array.isArray(payload.predictions)) {
      return new Map()
    }
    return new Map(
      payload.predictions
        .filter((item) => /^BK\d{4}$/.test(String(item?.code || '')))
        .map((item) => [String(item.code), {
          nextProbability: probabilityPct(item.nextProbability),
          weekProbability: probabilityPct(item.weekProbability),
          drawdownEstimate: Number.isFinite(Number(item.drawdownEstimate))
            ? +Number(item.drawdownEstimate).toFixed(2)
            : null,
          modelVersion: String(item.modelVersion || '').slice(0, 80),
        }]),
    )
  } catch {
    return new Map()
  } finally {
    clearTimeout(timer)
  }
}
