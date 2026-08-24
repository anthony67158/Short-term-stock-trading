export const SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH = 4000
export const SECTOR_CONCEPT_EXPLANATION_LIMIT = 120

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
    '请优先调用 web_news 联网搜索核验公开资料，并只回答概念本身。',
    '按“这是什么、为什么会形成这个概念、通常包含哪些业务、容易误解什么”四部分简洁说明。',
    stocks.length ? `当前真实成分股示例：${stocks.join('、')}。` : '',
    '不要分析当前涨跌、不要预测走势、不提供买卖建议。',
    '使用清晰中文 Markdown，总长度控制在 800 字以内；具体外部事实标注对应证据编号。',
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
