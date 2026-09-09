import { parseLLMJson } from './_llm.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'

function closeContainersOnly(content) {
  const raw = String(content || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  if (!raw.startsWith('{')) return null
  const stack = []
  let quoted = false
  let escaped = false
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null
    }
  }
  // Never complete a cut string, number, or key. Only closing delimiters
  // after a complete string/container value can be recovered without guessing.
  if (quoted || escaped || !stack.length || !/["}\]]$/.test(raw)) return null
  try { return JSON.parse(raw + stack.reverse().join('')) } catch { return null }
}

export function parseAdvisorModelOutput({
  content = '', reasoning = '', mode = '',
  validate = (value) => adviceCompleteness(value, mode),
} = {}) {
  const candidates = []
  for (const [source, text] of [['content', content], ['reasoning', reasoning]]) {
    if (!String(text).trim()) continue
    const parsed = parseLLMJson(String(text))
    const value = parsed.repaired ? closeContainersOnly(text) : parsed.value
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value : null
    const quality = validate(object)
    const candidate = {
      value: object,
      complete: !!object && quality.complete,
      source,
      closingDelimitersRecovered: !!object && parsed.repaired,
      missing: quality.missing,
      failureKind: !object ? 'INVALID_JSON' : 'MISSING_FIELDS',
    }
    if (candidate.complete) return { ...candidate, failureKind: null }
    candidates.push(candidate)
  }
  return candidates.find((item) => item.value) || candidates[0] || {
    value: null, complete: false, source: 'none', closingDelimitersRecovered: false,
    missing: adviceCompleteness(null, mode).missing, failureKind: 'EMPTY_OUTPUT',
  }
}
