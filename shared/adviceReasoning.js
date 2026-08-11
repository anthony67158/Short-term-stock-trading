function clean(value, limit = 1200) {
  const text = String(value || '').trim().replace(/\n{3,}/g, '\n\n')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

export function ensureAdviceReasoning(advice, streamedReasoning = '') {
  if (!advice || typeof advice !== 'object') return advice
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
