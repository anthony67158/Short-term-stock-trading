const GENERIC_TAG = /^(?:融资融券|深股通|沪股通|北向资金|基金重仓|机构重仓|证金持股|富时罗素|MSCI中国|HS300_?|上证50|上证180_?|深证100R|深成500|创业板综|创业成份|标准普尔|AH股|大盘股|中盘股|小盘股|百元股|科技风格|消费风格|行业龙头|破增发价股|高市盈率|高市净率|超跌股|昨日涨停|昨日触板|昨日炸板|昨日高振幅|东方财富热股|参股新三板|[一二三四]?季度预增|20\d{2}中报预增)$/

const FEATURED_TOPICS = new Map([
  ['PCB', 1200],
  ['MLCC', 1190],
  ['CPO', 1180],
  ['减肥药', 1170],
  ['创新药', 1160],
  ['光通信模块', 1150],
  ['液冷', 1140],
  ['算力', 1130],
  ['人形机器人', 1120],
  ['固态电池', 1110],
  ['低空经济', 1100],
  ['商业航天', 1090],
])

const SPECIFIC_TOPIC = /(药|医疗|疫苗|芯片|半导体|光模块|光通信|液冷|算力|机器人|电池|低空|航天|卫星|量子|稀土|存储|封装|光伏|风电|核电|军工|数据要素|消费电子|被动元件|AI)/

function clean(value, max = 40) {
  const result = String(value ?? '').trim()
  if (!result || result === '-') return ''
  return result.slice(0, max)
}

export function normalizeStockConceptName(value) {
  const name = clean(value)
  if (!name) return ''
  return name.endsWith('概念') && name.length > 2
    ? name.slice(0, -2)
    : name
}

export function normalizeStockConcepts(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,，、;；|]/)
  const seen = new Set()
  const output = []
  for (const item of source) {
    const name = clean(item)
    if (!name || GENERIC_TAG.test(name) || seen.has(name)) continue
    seen.add(name)
    output.push(name)
    if (output.length >= 40) break
  }
  return output
}

export function normalizeStockIndustry(value) {
  const industry = clean(value)
  if (!industry || GENERIC_TAG.test(industry) || industry.endsWith('板块')) {
    return ''
  }
  return industry
}

function normalizeConceptBoardCode(value) {
  const raw = String(value ?? '').trim().replace(/^BK/i, '')
  return /^\d{1,4}$/.test(raw) ? `BK${raw.padStart(4, '0')}` : ''
}

export function normalizeStockConceptBoards(value) {
  const source = Array.isArray(value) ? value : []
  const seen = new Set()
  const output = []
  for (const item of source) {
    const name = normalizeStockConceptName(item?.name)
    const code = normalizeConceptBoardCode(item?.code)
    if (!name || GENERIC_TAG.test(name) || !code || seen.has(code)) continue
    seen.add(code)
    output.push({
      code,
      name,
      rank: Number.isFinite(Number(item?.rank)) ? Number(item.rank) : null,
    })
  }
  return output
}

function topicScore(name, index) {
  const normalized = normalizeStockConceptName(name)
  let score = FEATURED_TOPICS.get(normalized) || 0
  if (/^[A-Z][A-Z0-9.+-]{1,8}$/.test(normalized)) score += 600
  if (SPECIFIC_TOPIC.test(normalized)) score += 300
  score += Math.max(0, 100 - index)
  return score
}

export function buildStockTagProfile({
  code,
  name,
  industry,
  concepts,
  conceptBoards,
  conceptVerified = false,
  source = '东方财富',
} = {}) {
  const normalizedIndustry = normalizeStockIndustry(industry)
  const normalizedConcepts = normalizeStockConcepts(concepts)
  const normalizedBoards = normalizeStockConceptBoards(conceptBoards)
  const primaryRaw = normalizedConcepts
    .map((concept, index) => ({
      concept,
      index,
      score: topicScore(concept, index),
    }))
    .filter((item) =>
      normalizeStockConceptName(item.concept) !== normalizedIndustry
    )
    .sort((left, right) =>
      right.score - left.score || left.index - right.index
    )[0]?.concept
  const primaryTopic = primaryRaw
    ? normalizeStockConceptName(primaryRaw)
    : null
  const displayTags = []
  const visibleConcepts = [...new Set(
    normalizedConcepts.map(normalizeStockConceptName).filter(Boolean),
  )]
    .map((concept, index) => ({
      concept,
      index,
      score: topicScore(concept, index),
    }))
    .sort((left, right) =>
      right.score - left.score || left.index - right.index
    )
    .map((item) => item.concept)
  for (const concept of visibleConcepts.slice(0, 1)) {
    displayTags.push({ name: concept, kind: 'concept' })
  }
  if (
    normalizedIndustry
    && !visibleConcepts.includes(normalizedIndustry)
  ) {
    displayTags.push({ name: normalizedIndustry, kind: 'industry' })
  }
  return {
    code: clean(code, 6),
    name: clean(name, 40),
    industry: normalizedIndustry || null,
    concepts: normalizedConcepts,
    conceptBoards: normalizedBoards,
    conceptVerified: !!conceptVerified && normalizedBoards.length > 0,
    primaryTopic,
    displayTags,
    source,
  }
}

export function normalizeStockTagCodes(value, limit = 80) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '').split(',')
  return [...new Set(
    source
      .map((item) => String(item ?? '').trim())
      .filter((code) => /^\d{6}$/.test(code)),
  )].slice(0, Math.max(1, Math.min(200, Number(limit) || 80)))
}
