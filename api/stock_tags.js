import {
  emGetOne,
  preflight,
  sendError,
  sendJson,
} from './_lib.js'
import {
  buildStockTagProfile,
  normalizeStockTagCodes,
} from '../shared/stockTags.js'

const TAG_CACHE_TTL_MS = 5 * 60 * 1000
const EMPTY_CACHE_TTL_MS = 2 * 60 * 1000
const tagCache = new Map()

function toSecid(code) {
  if (/^(4|8|92)/.test(code)) return `0.${code}`
  return /^(6|9|5)/.test(code) ? `1.${code}` : `0.${code}`
}

function toF10Code(code) {
  if (/^(4|8|92)/.test(code)) return `BJ${code}`
  return /^(6|9|5)/.test(code) ? `SH${code}` : `SZ${code}`
}

export function stockTagProfileFromEastmoney(data, fallbackCode = '') {
  return buildStockTagProfile({
    code: data?.f57 || fallbackCode,
    name: data?.f58 || '',
    industry: data?.f127,
    concepts: data?.f129,
    source: '东方财富个股资料',
  })
}

export function stockTagProfileFromCoreConception(
  payload,
  fallbackCode = '',
) {
  const rows = Array.isArray(payload?.ssbk)
    ? payload.ssbk
    : []
  const ordered = rows.slice().sort(
    (left, right) =>
      Number(left?.BOARD_RANK || 999)
      - Number(right?.BOARD_RANK || 999),
  )
  const base = ordered.find((item) => item?.SECURITY_CODE) || {}
  const industryHierarchy = ordered
    .filter((item) =>
      item?.IS_PRECISE == null
      && item?.BOARD_NAME
      && Number(item?.BOARD_RANK) <= 3
    )
    .map((item) => item.BOARD_NAME)
  const industry = industryHierarchy[1] || industryHierarchy[0] || ''
  const concepts = ordered
    .filter((item) =>
      item?.IS_PRECISE === '1'
      && item?.BOARD_NAME
    )
    .map((item) => item.BOARD_NAME)
  const conceptBoards = ordered
    .filter((item) =>
      item?.IS_PRECISE === '1'
      && item?.BOARD_NAME
      && item?.BOARD_CODE
    )
    .map((item) => ({
      code: item.BOARD_CODE,
      name: item.BOARD_NAME,
      rank: Number(item.BOARD_RANK),
    }))
  return buildStockTagProfile({
    code: base.SECURITY_CODE || fallbackCode,
    name: base.SECURITY_NAME_ABBR || '',
    industry,
    concepts,
    conceptBoards,
    conceptVerified: conceptBoards.length > 0,
    source: '东方财富F10核心题材',
  })
}

export function stockTagProfileFromSources(
  detailData,
  corePayload,
  fallbackCode = '',
) {
  const detail = stockTagProfileFromEastmoney(
    detailData,
    fallbackCode,
  )
  const core = stockTagProfileFromCoreConception(
    corePayload,
    fallbackCode,
  )
  return buildStockTagProfile({
    code: detail.code || core.code || fallbackCode,
    name: detail.name || core.name,
    industry: detail.industry || core.industry,
    concepts: core.concepts.length ? core.concepts : detail.concepts,
    conceptBoards: core.conceptBoards,
    conceptVerified: core.conceptVerified,
    source: detailData && corePayload
      ? '东方财富个股资料+F10核心题材'
      : detailData
        ? detail.source
        : core.source,
  })
}

async function fetchCoreConception(code) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 7000)
  try {
    const response = await fetch(
      'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax'
      + `?code=${toF10Code(code)}`,
      {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          Referer: 'https://emweb.securities.eastmoney.com/',
          Accept: 'application/json, text/plain, */*',
        },
      },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchStockDetailData(code, fetcher) {
  const path =
    '/api/qt/stock/get?ut=fa5fd1943c7b386f172d6893dbfba10b'
    + `&invt=2&fltt=2&secid=${toSecid(code)}`
    + '&fields=f57,f58,f127,f129'
  const response = await fetcher(path, {
    hostIndex: 3,
    maxAttempts: 2,
  })
  return response?.data || null
}

export async function fetchStockTagProfile(
  code,
  fetcher = emGetOne,
  now = Date.now(),
) {
  const cached = tagCache.get(code)
  const cacheTtl = cached?.data?.displayTags?.length
    ? TAG_CACHE_TTL_MS
    : EMPTY_CACHE_TTL_MS
  if (cached && now - cached.at < cacheTtl) return cached.data

  const [detailResult, coreResult] = await Promise.allSettled([
    fetchStockDetailData(code, fetcher),
    fetchCoreConception(code),
  ])
  const detailData = detailResult.status === 'fulfilled'
    ? detailResult.value
    : null
  const corePayload = coreResult.status === 'fulfilled'
    ? coreResult.value
    : null

  if (detailData || corePayload) {
    const profile = {
      ...stockTagProfileFromSources(detailData, corePayload, code),
      fetchedAt: now,
    }
    tagCache.set(code, { at: now, data: profile })
    return profile
  }

  if (cached?.data) return { ...cached.data, stale: true }
  return {
    ...buildStockTagProfile({ code, source: '东方财富个股资料' }),
    fetchedAt: now,
    unavailable: true,
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        output[index] = await mapper(items[index], index)
      }
    },
  )
  await Promise.all(workers)
  return output
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  try {
    const codes = normalizeStockTagCodes(req.query?.codes, 80)
    if (!codes.length) {
      return sendJson(res, {
        ok: true,
        updatedAt: Date.now(),
        list: [],
      }, { cache: 60 })
    }
    const list = await mapWithConcurrency(
      codes,
      8,
      (code) => fetchStockTagProfile(code),
    )
    return sendJson(res, {
      ok: true,
      updatedAt: Date.now(),
      schemaVersion: 'stock-tags.v5',
      source: '东方财富个股资料+F10核心题材',
      list,
    }, { cache: 60 })
  } catch (error) {
    return sendError(res, error)
  }
}
