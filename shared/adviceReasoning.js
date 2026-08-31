function clean(value, limit = 1200) {
  const text = String(value || '').trim().replace(/\n{3,}/g, '\n\n')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

const STEP_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

export function splitAdviceReasoningSteps(value) {
  const raw = String(value || '').trim()
  if (!raw) return []
  if (STEP_MARKS.some((mark) => raw.includes(mark))) {
    const parts = []
    const pattern = /([①②③④⑤⑥⑦⑧⑨⑩])/g
    let lastIndex = 0
    let match
    let current = null
    while ((match = pattern.exec(raw)) !== null) {
      if (current !== null) {
        parts.push({
          mark: current,
          body: raw.slice(lastIndex, match.index).trim(),
        })
      }
      current = match[1]
      lastIndex = match.index + match[1].length
    }
    if (current !== null) {
      parts.push({ mark: current, body: raw.slice(lastIndex).trim() })
    }
    return parts
      .filter((part) => part.body)
      .map((part, index) => ({
        mark: STEP_MARKS[index] || part.mark,
        body: part.body.replace(/^→\s*/, ''),
      }))
  }
  const separator = raw.includes('\n')
    ? /\n+/
    : raw.includes('→') ? /→/ : null
  if (!separator) return [{ mark: '', body: raw }]
  return raw
    .split(separator)
    .map((body) => body.trim())
    .filter(Boolean)
    .map((body, index) => ({
      mark: STEP_MARKS[index] || '·',
      body,
    }))
}

function normalized(value) {
  return clean(value, 500)
    .replace(/[，。；：、,.!?！？\s]/g, '')
    .toLowerCase()
}

function uniqueText(values = [], limit = 220) {
  const seen = []
  const output = []
  for (const value of values) {
    const text = clean(value, limit)
    const key = normalized(text)
    if (!key) continue
    if (seen.some((prior) =>
      prior === key
      || (
        Math.min(prior.length, key.length) >= 16
        && (prior.includes(key) || key.includes(prior))
      )
    )) continue
    seen.push(key)
    output.push(text)
  }
  return output
}

export function buildDeepAdviceReasoningSummary(
  advice,
  streamedReasoning = '',
) {
  if (!advice || typeof advice !== 'object') return ''
  const existing = clean(advice.reasoning)
  if (
    existing.split('\n').filter(Boolean).length >= 3
    && /(?:结论|量化|技术|资金|消息|风险|执行)：/.test(existing)
  ) return existing

  const conclusion = uniqueText([
    advice.title || advice.headline,
    advice.actionPlan || advice.nextAction,
  ], 180).join('；')
  const risk = uniqueText([
    advice.bearCase || advice.risk,
    advice.invalidation,
  ], 180).join('；')
  const dimensions = [
    ['结论', conclusion || advice.reason],
    ['量化', advice.quantNote],
    ['技术', advice.techNote],
    ['资金', advice.fundNote],
    ['消息', advice.newsNote || advice.macroNote],
    ['风险', risk],
  ]
  const used = []
  const lines = []
  for (const [label, value] of dimensions) {
    const text = clean(value, 220)
    const key = normalized(text)
    if (!key) continue
    if (used.some((prior) =>
      prior === key
      || (
        Math.min(prior.length, key.length) >= 20
        && (prior.includes(key) || key.includes(prior))
      )
    )) continue
    used.push(key)
    lines.push(`${label}：${text}`)
  }
  if (lines.length >= 3) return clean(lines.join('\n'))

  const fallback = uniqueText([
    existing,
    streamedReasoning,
    advice.quantNote,
    advice.techNote,
    advice.fundNote,
    advice.reason,
    advice.actionPlan || advice.nextAction || advice.title,
  ], 360)
  return fallback.length
    ? clean(fallback.join('；'))
    : '已综合行情、资金、技术与风险约束形成当前结论。'
}

export function deepModelProgressMessage(elapsedMs = 0) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0)
  const seconds = Math.floor(elapsed / 1000)
  if (elapsed >= 45000) {
    return `模型仍在生成完整结论，连接正常；已等待${seconds}秒，达到时限将自动结束本轮。`
  }
  if (elapsed >= 30000) {
    return `正在收束唯一动作、关键价位与失效条件…已用时${seconds}秒`
  }
  if (elapsed >= 15000) {
    return `正在交叉核验多空证据与账户风险约束…已用时${seconds}秒`
  }
  if (elapsed >= 10000) {
    return `深度模型已接收任务，正在建立多空假设…已用时${seconds}秒`
  }
  return ''
}

export function ensureAdviceReasoning(
  advice,
  streamedReasoning = '',
  { deepMode = false } = {},
) {
  if (!advice || typeof advice !== 'object') return advice
  if (deepMode) {
    return {
      ...advice,
      reasoning: buildDeepAdviceReasoningSummary(
        advice,
        streamedReasoning,
      ),
    }
  }
  if (clean(advice.reasoning)) {
    return { ...advice, reasoning: clean(advice.reasoning) }
  }
  const streamed = clean(streamedReasoning)
  if (streamed) return { ...advice, reasoning: streamed }
  const pieces = [
    advice.quantNote,
    advice.techNote,
    advice.fundNote,
    advice.reason,
    advice.actionPlan || advice.timing || advice.title,
  ].map((value) => clean(value, 360)).filter(Boolean)
  const unique = [...new Set(pieces)]
  return {
    ...advice,
    reasoning: unique.length
      ? clean(unique.join('；'))
      : '已综合行情、资金、技术与风险约束形成当前结论。',
  }
}
