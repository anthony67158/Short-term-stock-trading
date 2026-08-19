const MODE_TERMS = {
  buy_advice: '龙头战法 短线情绪周期 题材主线 分歧转一致 趋势突破 量价确认 仓位风控',
  hold_advice: '龙头战法 短线情绪周期 趋势跟随 量价确认 止盈止损 仓位管理',
  t_advice: '均值回归 支撑压力 量价关系 做T低吸高抛 仓位风控',
  review: '趋势复盘 情绪周期 量价关系 交易纪律 风险管理',
  plan: '支撑压力 趋势跟随 仓位管理 止盈止损',
}

function text(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildAdvisorTheoryQuery(mode, payload = {}) {
  const event = payload.eventSignal || {}
  const parts = [
    text(payload.name, 40),
    text(payload.code, 12),
    text(payload.industry, 40),
    'A股短线 个股操作建议',
    MODE_TERMS[mode] || MODE_TERMS.plan,
  ]
  if (event.limitUpToday || Number(event.limitStreak) > 0) {
    parts.push(
      `龙头战法 连板${Number(event.limitStreak) || ''}板 情绪周期 题材主线 分歧转一致`,
    )
  }
  if (Array.isArray(event.reasons)) {
    parts.push(text(event.reasons.join(' '), 160))
  }
  parts.push(
    text(payload.marketEnv?.level, 40),
    text(payload.intraday?.rhythm, 60),
    text(payload.tech?.maTrend, 60),
    text(payload.tech?.maCross, 60),
    text(payload.counterTrend?.note, 120),
  )
  return parts.filter(Boolean).join(' ')
}

export function theoryReferencesOf(hits = [], limit = 6) {
  const seen = new Set()
  const references = []
  for (const hit of Array.isArray(hits) ? hits : []) {
    const book = text(hit?.book, 80)
    const topic = text(hit?.topic, 80)
    if (!book || !topic) continue
    const key = `${book}\u0000${topic}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push({ book, topic })
    if (references.length >= limit) break
  }
  return references
}

export function buildAdvisorTheoryBlock(hits = []) {
  const selected = (Array.isArray(hits) ? hits : [])
    .filter((hit) => text(hit?.text, 2400))
    .slice(0, 6)
  if (!selected.length) return ''
  return `
【★★经典理论知识库动态检索·与军师侧边栏同源】
以下是从同一套经典理论知识库中按本股形态动态检索出的候选依据：
${selected.map((hit, index) => `${index + 1}. ${text(hit.text, 2400)}`).join('\n')}
使用规则：
1. 先用实时行情、资金、消息、量化和账户约束判断事实，再选理论解释；不得因为检索命中就生搬硬套。
2. theoryNote 必须从上述候选与完整理论库中选最贴合的2个，必要时最多3个，并逐个写清“本股哪项具体证据符合/不符合、因此如何影响当前动作”。
3. 龙头战法、情绪周期只在连板梯队、题材主线、封板/炸板、分歧一致等证据成立时使用；没有龙头证据时必须明确“不适用”，不得把普通股包装成龙头。
4. 理论与事实冲突时，以实时证据和风控纪律为准。`
}
