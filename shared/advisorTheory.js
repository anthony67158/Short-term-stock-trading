const MODE_TERMS = {
  buy_advice: '龙头战法 短线情绪周期 题材主线 分歧转一致 趋势突破 量价确认 仓位风控',
  hold_advice: '龙头战法 短线情绪周期 趋势跟随 量价确认 止盈止损 仓位管理',
  t_advice: '均值回归 支撑压力 量价关系 做T低吸高抛 仓位风控',
  review: '趋势复盘 情绪周期 量价关系 交易纪律 风险管理',
  plan: '支撑压力 趋势跟随 仓位管理 止盈止损',
}

const THEORY_TAGS = [
  { tag: '龙头战法', re: /龙头战法|只做龙头|分歧转一致|一致转分歧|打板|接力/ },
  { tag: '短线情绪周期', re: /短线情绪周期|情绪周期|冰点|修复期|发酵期|高潮期|退潮期|炸板率|晋级率/ },
  { tag: '题材主线', re: /题材主线|主线与持续性|板块效应|题材生命周期|板块轮动|资金搬家/ },
  { tag: '缠论结构', re: /缠论|走势中枢|中枢突破|一买|二买|三买|背驰/ },
  { tag: '利弗莫尔关键点', re: /利弗莫尔|关键点|飞刀|金字塔加仓|错了.{0,3}认错|绝不摊亏/ },
  { tag: '欧奈尔CANSLIM', re: /欧奈尔|奈尔|can\s*slim|canslim|8%.{0,3}止损|buy\s*point|买点突破/i },
  { tag: '米勒维尼VCP', re: /米勒维尼|维尼|vcp|sepa|波动收缩/i },
  { tag: '威科夫量价', re: /威科夫|wyckoff|吸筹.{0,12}派发|派发.{0,12}吸筹/i },
  { tag: '温斯坦阶段', re: /温斯坦|weinstein|阶段分析|第二上升阶段|30周线/i },
  { tag: '道氏趋势', re: /道氏|dow|趋势三级|主要趋势.{0,12}次级趋势|指数.{0,12}相互验证/i },
  { tag: '量价关系', re: /量价关系|量在价先|放量突破|缩量回踩|放量滞涨|地量地价/ },
  { tag: '均线支撑压力', re: /均线系统|5日均线|10日均线|支撑压力|压力转支撑|跌破支撑/ },
  { tag: '蜡烛图形态', re: /蜡烛图|锤子线|启明星|黄昏星|吞没|十字星|射击之星/ },
  { tag: '均值回归', re: /均值回归|超买超卖|布林|回归中轨|震荡区间|高抛低吸/ },
  { tag: '海龟趋势', re: /海龟|唐奇安|趋势跟随|20日新高|10日新低/ },
  { tag: '专业投机法则', re: /斯波朗迪|专业投机|1-2-3法则|2B法则|2b法则/ },
  { tag: '凯利/R风控', re: /凯利|kelly|撒普|r\s*倍数|半凯利/i },
  { tag: '处置效应', re: /处置效应|让利润奔跑|亏损快砍|截短亏损|赚一点就跑|亏了死扛/ },
  { tag: '索罗斯反身性', re: /索罗斯|反身性|泡沫|拐点/ },
  { tag: '科斯托拉尼钟摆', re: /科斯托拉尼|情绪钟摆|众人贪婪|众人恐慌|追顶|割底/ },
  { tag: '基本面选股', re: /彼得.{0,2}林奇|peg|好行业.{0,3}好公司.{0,3}好价格|安全边际/i },
]

function text(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function adviceTheoryTextOf(value) {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  return String(value.theoryNote || value.theory || '').trim()
}

export function theoryTagsOf(note, limit = 3) {
  const source = adviceTheoryTextOf(note)
  if (!source.trim()) return []
  const matches = THEORY_TAGS
    .map((item, order) => {
      const match = source.match(item.re)
      return match
        ? { tag: item.tag, index: match.index ?? order, order }
        : null
    })
    .filter(Boolean)
    .sort((left, right) =>
      (left.index - right.index) || (left.order - right.order),
    )
  const specific = new Set(matches.map((item) => item.tag))
  return matches
    .filter((item) =>
      item.tag !== '量价关系' || !specific.has('威科夫量价'),
    )
    .slice(0, Math.max(1, Number(limit) || 3))
    .map((item) => item.tag)
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
