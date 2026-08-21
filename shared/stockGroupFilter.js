import { normalizeStockConceptName } from './stockTags.js'

const ALL_GROUP = '全部'
const OTHER_GROUP = '其他'

function codeOf(item) {
  return String(item?.code || '').trim()
}

function text(value) {
  return String(value || '').trim()
}

function tagConcepts(info) {
  const primary = normalizeStockConceptName(info?.primaryTopic)
  if (primary) return [primary]
  const display = Array.isArray(info?.displayTags)
    ? info.displayTags
      .filter((tag) => tag?.kind === 'concept')
      .map((tag) => normalizeStockConceptName(tag.name))
      .filter(Boolean)
    : []
  if (display[0]) return [display[0]]
  const concepts = Array.isArray(info?.concepts)
    ? info.concepts.map(normalizeStockConceptName).filter(Boolean)
    : []
  return concepts[0] ? [concepts[0]] : []
}

export function stockGroupNames(
  item,
  tagInfo,
  quote,
  dimension = 'concept',
) {
  if (dimension === 'industry') {
    return [text(tagInfo?.industry)
      || text(quote?.industry)
      || text(item?.industry)
      || OTHER_GROUP]
  }
  if (tagInfo == null) return []
  const concepts = tagConcepts(tagInfo)
  return concepts.length ? concepts : [OTHER_GROUP]
}

export function stockGroupName(
  item,
  tagInfo,
  quote,
  dimension = 'concept',
) {
  return stockGroupNames(item, tagInfo, quote, dimension)[0] || ''
}

export function buildStockGroups(items, {
  dimension = 'concept',
  tagMap = {},
  quoteMap = {},
} = {}) {
  const groups = new Map()
  const seenCodes = new Set()

  for (const item of items || []) {
    const code = codeOf(item)
    if (!code || seenCodes.has(code)) continue
    seenCodes.add(code)
    const quote = quoteMap[code]
    const names = stockGroupNames(item, tagMap[code], quote, dimension)
    for (const name of names) {
      if (!name) continue
      const group = groups.get(name) || {
        name,
        count: 0,
        pctSum: 0,
        pctCount: 0,
      }
      group.count++
      const pct = Number(quote?.pct)
      if (Number.isFinite(pct)) {
        group.pctSum += pct
        group.pctCount++
      }
      groups.set(name, group)
    }
  }

  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      count: group.count,
      avgPct: group.pctCount
        ? +(group.pctSum / group.pctCount).toFixed(2)
        : null,
    }))
    .sort((left, right) => {
      if (left.name === OTHER_GROUP) return 1
      if (right.name === OTHER_GROUP) return -1
      if (right.count !== left.count) return right.count - left.count
      return (right.avgPct ?? -999) - (left.avgPct ?? -999)
        || left.name.localeCompare(right.name, 'zh-CN')
    })
}

export function filterStocksByGroup(items, group = ALL_GROUP, options = {}) {
  if (!group || group === ALL_GROUP) return [...(items || [])]
  const { dimension = 'concept', tagMap = {}, quoteMap = {} } = options
  return (items || []).filter((item) => {
    const code = codeOf(item)
    return stockGroupNames(
      item,
      tagMap[code],
      quoteMap[code],
      dimension,
    ).includes(group)
  })
}

function uniqueStocks(items) {
  const seen = new Set()
  return (items || []).filter((item) => {
    const code = codeOf(item)
    if (!code || seen.has(code)) return false
    seen.add(code)
    return true
  })
}

export function toggleBatchGroupSelection(current, group) {
  const selected = [...new Set(
    (Array.isArray(current) ? current : [current])
      .map(text)
      .filter(Boolean),
  )]
  const next = text(group)
  if (!next) return selected
  if (next === ALL_GROUP) {
    return selected.includes(ALL_GROUP) ? [] : [ALL_GROUP]
  }
  const withoutAll = selected.filter((name) => name !== ALL_GROUP)
  return withoutAll.includes(next)
    ? withoutAll.filter((name) => name !== next)
    : [...withoutAll, next]
}

export function selectBatchGroupCodes({
  holdings = [],
  watchlist = [],
  scope = 'all',
  pinnedOnly = false,
  dimension = 'concept',
  group = ALL_GROUP,
  groups = null,
  tagMap = {},
  quoteMap = {},
} = {}) {
  const scopedPool = scope === 'holding'
    ? holdings
    : scope === 'watchlist'
      ? watchlist
      : [...holdings, ...watchlist]
  const pool = pinnedOnly
    ? scopedPool.filter((item) => item?.star === true)
    : scopedPool
  const selectedGroups = [...new Set(
    (Array.isArray(groups) ? groups : [group])
      .map(text)
      .filter(Boolean),
  )]
  if (!selectedGroups.length) return []
  if (selectedGroups.includes(ALL_GROUP)) return uniqueStocks(pool).map(codeOf)
  return uniqueStocks(pool)
    .filter((item) => {
      const code = codeOf(item)
      const names = stockGroupNames(
        item,
        tagMap[code],
        quoteMap[code],
        dimension,
      )
      return selectedGroups.some((name) => names.includes(name))
    })
    .map(codeOf)
}
