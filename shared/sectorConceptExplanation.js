export const SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH = 4000
export const SECTOR_CONCEPT_EXPLANATION_LIMIT = 120
export const SECTOR_CONCEPT_EXPLANATION_MAX_TOKENS = 640

function cleanText(value, limit) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  return Array.from(text).slice(0, limit).join('')
}

function validCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return /^BK\d{4,6}$/.test(code) ? code : ''
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      title: cleanText(item?.title, 160),
      source: cleanText(item?.source || item?.src, 60),
      date: cleanText(item?.date || item?.asOf, 32),
      url: safeUrl(item?.url),
    }))
    .filter((item) => item.title)
    .slice(0, 6)
}

export function normalizeSectorConceptExplanation(value, fallbackCode = '') {
  if (!value || typeof value !== 'object') return null
  const code = validCode(value.code || fallbackCode)
  const text = cleanText(
    value.text || value.answer,
    SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH,
  )
  const updatedAt = Number(value.updatedAt)
  if (!code || !text || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return null
  }
  return {
    schemaVersion: 'sector-concept-explanation.v1',
    code,
    name: cleanText(value.name, 60),
    text,
    evidence: normalizeEvidence(value.evidence),
    model: cleanText(value.model, 80),
    updatedAt,
  }
}

export function normalizeSectorConceptExplanations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([code, explanation]) => {
        const normalized = normalizeSectorConceptExplanation(
          explanation,
          code,
        )
        return normalized ? [normalized.code, normalized] : null
      })
      .filter(Boolean)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, SECTOR_CONCEPT_EXPLANATION_LIMIT),
  )
}

export function mergeSectorConceptExplanations(
  primary = {},
  secondary = {},
) {
  const merged = normalizeSectorConceptExplanations(secondary)
  for (
    const [code, explanation]
    of Object.entries(normalizeSectorConceptExplanations(primary))
  ) {
    const current = merged[code]
    if (!current || explanation.updatedAt >= current.updatedAt) {
      merged[code] = explanation
    }
  }
  return normalizeSectorConceptExplanations(merged)
}

export function sectorConceptExplanationsAfter(
  explanations = {},
  since = 0,
) {
  const after = Number(since) || 0
  return Object.fromEntries(
    Object.entries(normalizeSectorConceptExplanations(explanations))
      .filter(([, explanation]) => explanation.updatedAt > after),
  )
}

export function existingSectorConceptText(sector = {}) {
  const candidates = [
    sector.conceptExplanation?.text,
    sector.conceptExplanation,
    sector.conceptDefinition,
    sector.definition,
    sector.description,
  ]
  return candidates
    .map((value) => cleanText(value, SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH))
    .find(Boolean) || ''
}

export function sectorConceptExplanationPrompt(sector = {}) {
  const code = validCode(sector.code)
  const name = cleanText(sector.name, 60)
  const stocks = (Array.isArray(sector.stocks) ? sector.stocks : [])
    .map((item) => cleanText(item?.name, 40))
    .filter(Boolean)
    .slice(0, 5)
  return [
    `请解释A股概念板块“${name}”${code ? `（${code}）` : ''}。`,
    '请优先调用 web_news 联网核验公开资料，只回答概念本身。',
    '输出只能使用以下三个标题，不得增加开场白、结语或其他小节：',
    '### 一句话看懂',
    '用 1 句话说明它把哪类公司归在一起，以及共同业务或资源是什么，55 个汉字以内。',
    '### 为什么形成',
    '用 1 句话说明市场为何把它单独归类，聚焦真实产业驱动，70 个汉字以内。',
    '### 怎么辨认',
    '只写两条短句：“主要看：……”和“不要混同：……”，每条 45 个汉字以内。',
    stocks.length
      ? `成分股样本仅供核验概念边界：${stocks.join('、')}；不得逐只介绍或列出成分股。`
      : '',
    '正文总计不超过 220 个汉字。每个事实只说一次，不要铺陈完整产业链，不要罗列公司、产品或政策清单。',
    '不要分析当前涨跌、不要预测走势、不提供买卖建议。',
    '使用简明中文 Markdown；需要引用时，把对应[证据N]放在相关短句末尾。',
  ].filter(Boolean).join('\n')
}

export function sectorConceptExplanationSummary(value, limit = 120) {
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s+/.test(line))
  const source = lines.find((line) => !/^[-*]\s+/.test(line))
    || lines[0]
    || ''
  const plain = cleanText(source, Math.max(1, Number(limit) || 120) + 20)
    .replace(/\[证据\d+\]/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const characters = Array.from(plain)
  const maximum = Math.max(1, Number(limit) || 120)
  return characters.length > maximum
    ? `${characters.slice(0, maximum).join('')}…`
    : plain
}
