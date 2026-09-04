import {
  beijingDayKey,
} from '../shared/tradingCalendar.js'
import {
  PRE_CATALYST_SCHEMA_VERSION,
  buildPreCatalystCandidate,
  normalizePreCatalystAnnouncement,
  rankPreCatalystCandidates,
} from '../shared/preCatalyst.js'
import {
  fetchTailPickRealtimePool,
} from './_tail_pick_data.js'
import {
  fetchSectorMembers,
} from './_sector_forecast_data.js'
import {
  fetchKlineTx,
} from './stock_detail.js'
import {
  fetchStockTagProfile,
} from './stock_tags.js'

const CNINFO_URL =
  'https://www.cninfo.com.cn/new/hisAnnouncement/query'
const CNINFO_REFERER = 'https://www.cninfo.com.cn/'
const MAX_RELEVANT_EVENTS = 16
const MAX_RELATIONS_PER_EVENT = 4

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function dayOffset(now, days) {
  return beijingDayKey(
    (Number(now) || Date.now()) - Math.max(0, days) * 86400000,
  )
}

async function fetchJsonWithTimeout(
  fetchImpl,
  url,
  options,
  timeoutMs,
) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    })
    if (!response?.ok) {
      throw new Error(`巨潮资讯HTTP ${response?.status || 0}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchCninfoAnnouncements({
  now = Date.now(),
  lookbackDays = 4,
  pageSize = 100,
  pageLimit = 8,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  const timestamp = Number(now) || Date.now()
  const startDate = dayOffset(timestamp, lookbackDays)
  const endDate = beijingDayKey(timestamp)
  const size = clamp(pageSize, 1, 100)
  const maxPages = clamp(pageLimit, 1, 10)
  const events = new Map()
  let total = Infinity

  for (
    let pageNum = 1;
    pageNum <= maxPages && events.size < total;
    pageNum += 1
  ) {
    const body = new URLSearchParams({
      pageNum: String(pageNum),
      pageSize: String(size),
      column: 'szse',
      tabName: 'fulltext',
      plate: '',
      stock: '',
      searchkey: '',
      secid: '',
      category: '',
      trade: '',
      seDate: `${startDate}~${endDate}`,
      sortName: 'time',
      sortType: 'desc',
      isHLtitle: 'true',
    })
    const payload = await fetchJsonWithTimeout(
      fetchImpl,
      CNINFO_URL,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type':
            'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: CNINFO_REFERER,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            + 'AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        },
        body: body.toString(),
      },
      timeoutMs,
    )
    total = Math.max(
      0,
      Number(payload?.totalAnnouncement)
        || Number(payload?.totalRecordNum)
        || 0,
    )
    const rows = Array.isArray(payload?.announcements)
      ? payload.announcements
      : []
    for (const row of rows) {
      const event = normalizePreCatalystAnnouncement(row, {
        now: timestamp,
      })
      if (event) events.set(event.eventId, event)
    }
    if (rows.length < size) break
  }
  return [...events.values()]
}

async function mapLimit(items, concurrency, mapper) {
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

function rankPercentiles(rows, key) {
  const sorted = rows
    .map((item) => finite(item?.[key]))
    .filter((value) => value != null)
    .sort((left, right) => left - right)
  if (!sorted.length) return new Map()
  const result = new Map()
  for (const row of rows) {
    const value = finite(row?.[key])
    if (value == null || !row?.code) continue
    let lower = 0
    while (lower < sorted.length && sorted[lower] <= value) lower += 1
    result.set(String(row.code), lower / sorted.length)
  }
  return result
}

function relationEdges(value = {}) {
  const now = Date.now()
  return (Array.isArray(value?.edges) ? value.edges : [])
    .filter((edge) =>
      /^\d{6}$/.test(String(edge?.fromCode || ''))
      && /^\d{6}$/.test(String(edge?.toCode || ''))
      && (
        !finite(edge.validUntil)
        || Number(edge.validUntil) >= now
      )
    )
    .map((edge) => ({
      fromCode: String(edge.fromCode),
      toCode: String(edge.toCode),
      type: String(edge.type || 'SUPPLY_CHAIN').slice(0, 40),
      score: clamp(finite(edge.score) ?? 75, 0, 100),
      evidence: String(edge.evidence || '').slice(0, 120),
      sectorName: String(edge.sectorName || '').slice(0, 60),
    }))
}

function relationKey(eventId, code) {
  return `${String(eventId)}:${String(code)}`
}

function candidateQuote(quote, amountRanks, turnoverRanks) {
  return {
    ...quote,
    amountPercentile:
      amountRanks.get(String(quote.code)) ?? 0.5,
    turnoverPercentile:
      turnoverRanks.get(String(quote.code)) ?? 0.5,
  }
}

function selectConceptPeers(rows, directCode, limit) {
  return (Array.isArray(rows) ? rows : [])
    .filter((item) =>
      item?.code
      && String(item.code) !== String(directCode)
      && finite(item.price) > 0
      && finite(item.amount) >= 30_000_000
      && Math.abs(finite(item.pct) ?? 99) < 7
    )
    .sort((left, right) =>
      Number(right.mainInflow || 0) - Number(left.mainInflow || 0)
      || Math.abs(Number(left.pct || 0))
        - Math.abs(Number(right.pct || 0))
      || String(left.code).localeCompare(String(right.code))
    )
    .slice(0, limit)
}

function normalizedEvent(raw, previousById, now) {
  const event = raw?.schemaVersion === PRE_CATALYST_SCHEMA_VERSION
    ? raw
    : normalizePreCatalystAnnouncement(raw, { now })
  if (!event) return null
  const previous = previousById.get(event.eventId)
  return previous?.firstSeenAt
    ? { ...event, firstSeenAt: previous.firstSeenAt }
    : event
}

export async function collectPreCatalystSnapshot({
  now = Date.now(),
  fetchAnnouncements = (options) =>
    fetchCninfoAnnouncements(options),
  fetchUniverse = fetchTailPickRealtimePool,
  fetchTags = fetchStockTagProfile,
  fetchSectorMembers: fetchMembers = fetchSectorMembers,
  fetchKline = fetchKlineTx,
  readRelations = async () => ({ edges: [] }),
  previous = null,
} = {}) {
  const timestamp = Number(now) || Date.now()
  const [rawAnnouncements, universe, relationConfig] =
    await Promise.all([
      fetchAnnouncements({ now: timestamp }),
      fetchUniverse({ now: timestamp }),
      readRelations(),
    ])
  const quotes = Array.isArray(universe?.list)
    ? universe.list
    : []
  if (
    Number(universe?.total) <= 0
    || Number(universe?.inspectedCount) !== Number(universe?.total)
    || quotes.length !== Number(universe?.total)
  ) {
    throw new Error('预催化扫描未完整读取A股市场')
  }
  const quoteByCode = new Map(
    quotes
      .filter((item) => item?.code)
      .map((item) => [String(item.code), item]),
  )
  const amountRanks = rankPercentiles(quotes, 'amount')
  const turnoverRanks = rankPercentiles(quotes, 'turnover')
  const previousById = new Map(
    (Array.isArray(previous?.events) ? previous.events : [])
      .filter((item) => item?.eventId)
      .map((item) => [String(item.eventId), item]),
  )
  const events = (Array.isArray(rawAnnouncements)
    ? rawAnnouncements
    : [])
    .map((item) => normalizedEvent(item, previousById, timestamp))
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.publishedAt || 0) - Number(left.publishedAt || 0)
      || String(left.eventId).localeCompare(String(right.eventId))
    )
  const relevant = events
    .filter((item) => item.eligible && item.direction !== 'NEGATIVE')
    .sort((left, right) =>
      Number(right.materialityScore || 0)
        - Number(left.materialityScore || 0)
      || Number(right.publishedAt || 0)
        - Number(left.publishedAt || 0)
    )
    .slice(0, MAX_RELEVANT_EVENTS)

  const tagsByCode = new Map()
  await mapLimit(relevant, 4, async (event) => {
    const tags = await fetchTags(event.code).catch(() => null)
    if (tags) tagsByCode.set(event.code, tags)
  })

  const references = new Map()
  for (const event of relevant) {
    const directQuote = quoteByCode.get(event.code)
    if (directQuote) {
      references.set(relationKey(event.eventId, event.code), {
        event,
        code: event.code,
        quote: directQuote,
        tags: tagsByCode.get(event.code) || {},
        relation: {
          type: 'DIRECT',
          score: 100,
          evidence: '公告主体',
          originCode: event.code,
        },
      })
    }
  }

  for (const edge of relationEdges(relationConfig)) {
    const event = relevant.find((item) => item.code === edge.fromCode)
    const quote = quoteByCode.get(edge.toCode)
    if (!event || !quote) continue
    references.set(relationKey(event.eventId, edge.toCode), {
      event,
      code: edge.toCode,
      quote,
      tags: {},
      relation: {
        type: edge.type,
        score: edge.score,
        evidence: edge.evidence,
        originCode: edge.fromCode,
        sectorName: edge.sectorName,
      },
    })
  }

  const boards = new Map()
  for (const event of relevant) {
    const tags = tagsByCode.get(event.code) || {}
    for (const board of (tags.conceptBoards || []).slice(0, 2)) {
      if (!board?.code || boards.has(String(board.code))) continue
      boards.set(String(board.code), {
        code: String(board.code),
        name: String(board.name || ''),
      })
    }
  }
  const membersByBoard = new Map()
  await mapLimit([...boards.values()], 4, async (board) => {
    const members = await fetchMembers(board.code).catch(() => [])
    membersByBoard.set(board.code, members)
  })
  for (const event of relevant) {
    const tags = tagsByCode.get(event.code) || {}
    let added = 0
    for (const board of (tags.conceptBoards || []).slice(0, 2)) {
      const peers = selectConceptPeers(
        membersByBoard.get(String(board.code)),
        event.code,
        MAX_RELATIONS_PER_EVENT - added,
      )
      for (const peer of peers) {
        const quote = quoteByCode.get(String(peer.code)) || peer
        references.set(relationKey(event.eventId, peer.code), {
          event,
          code: String(peer.code),
          quote,
          tags: {
            industry: '',
            concepts: [String(board.name || '')].filter(Boolean),
          },
          relation: {
            type: 'CONCEPT_PEER',
            score: 55,
            evidence:
              `与公告主体同属F10精确题材“${String(board.name || '')}”`,
            originCode: event.code,
            sectorCode: String(board.code),
            sectorName: String(board.name || ''),
          },
        })
        added += 1
      }
      if (added >= MAX_RELATIONS_PER_EVENT) break
    }
  }

  const referencesByCode = new Map()
  for (const reference of references.values()) {
    const current = referencesByCode.get(reference.code)
    if (
      !current
      || Number(reference.event.materialityScore || 0)
        > Number(current.event.materialityScore || 0)
      || reference.relation.type === 'DIRECT'
    ) referencesByCode.set(reference.code, reference)
  }
  const candidateRows = await mapLimit(
    [...referencesByCode.values()].slice(0, 60),
    8,
    async (reference) => {
      const quote = candidateQuote(
        reference.quote,
        amountRanks,
        turnoverRanks,
      )
      const kline = await fetchKline(
        reference.code,
        '101',
        60,
      ).catch(() => null)
      return buildPreCatalystCandidate({
        event: reference.event,
        relation: reference.relation,
        quote,
        candles: kline?.candles || [],
        tags: reference.tags,
        now: timestamp,
      })
    },
  )
  const candidates = rankPreCatalystCandidates(
    candidateRows.filter(Boolean),
    { limit: 20, maxPerConcept: 2 },
  )
  const tradeDate = quotes
    .map((item) => String(item?.tradeDate || ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort()
    .at(-1) || beijingDayKey(timestamp)
  return {
    schemaVersion: PRE_CATALYST_SCHEMA_VERSION,
    status: 'READY',
    tradeDate,
    generatedAt: timestamp,
    dataAsOf: timestamp,
    source: {
      name: '巨潮资讯',
      authority: 'OFFICIAL',
      lookbackDays: 4,
    },
    model: {
      state: 'CALIBRATING',
      version: 'pre-catalyst-rule.v1',
      sampleCount: 0,
      probabilitiesPublished: false,
    },
    counts: {
      announcements: events.length,
      relevantEvents: relevant.length,
      directCandidates: [...references.values()].filter(
        (item) => item.relation.type === 'DIRECT',
      ).length,
      relatedCandidates: [...references.values()].filter(
        (item) => item.relation.type !== 'DIRECT',
      ).length,
      eligibleCandidates: candidates.length,
    },
    events: events.slice(0, 300),
    candidates,
  }
}
