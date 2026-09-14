// 低相关有效机会选择器（方案第2点：联合排序后按相关性去重，选 top-N）。
//
// 目标：把已按状态+联合排序分排好的候选，按「概念/板块/打法」相关性做贪心去重，
// 选出互不高度相关的有效机会，避免一篮子同涨同跌导致的伪分散与集中回撤。
// 这是纯选择层，不改候选的动作/价格/手数结论，只决定「本轮纳入哪几个」。
//
// 有效机会数(effectiveCount)是方案「年化 120-160 笔」的度量基础：只统计
// state=READY 且通过低相关约束纳入的机会。

export const LOW_CORRELATION_SELECTION_VERSION =
  'low-correlation-selection.v1'

function normSet(values) {
  const out = new Set()
  for (const v of Array.isArray(values) ? values : []) {
    const s = String(v || '').trim()
    if (s) out.add(s)
  }
  return out
}

// Jaccard 相似度：两个标签集合的交并比。
function jaccard(a, b) {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const v of a) if (b.has(v)) inter += 1
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

// 从候选对象抽取相关性维度。
function relationProfile(candidate) {
  const concepts = normSet(
    candidate?.concepts
    || candidate?.tags
    || candidate?.conceptTags,
  )
  const sector = String(
    candidate?.sector || candidate?.industry || '',
  ).trim()
  const playbook = String(
    candidate?.adaptive?.playbook?.key
    || candidate?.playbookId
    || '',
  ).trim()
  return { concepts, sector, playbook }
}

// 两个候选是否「高相关」：概念 Jaccard 超阈值即视为高相关。
// 注意：同板块由 maxPerSector 单独限额，不在此重复判定，否则 maxPerSector 永远
// 触发不到（第二只同板块会先被这里拦掉），两个约束语义会互相吞没。
function highlyCorrelated(a, b, { conceptJaccardMax }) {
  if (jaccard(a.concepts, b.concepts) > conceptJaccardMax) return true
  return false
}

// 贪心选择：按输入顺序（已排序）逐个尝试纳入，若与任一已选高相关则跳过，
// 直到达到 maxSelections 或候选耗尽。同一板块允许的数量由 maxPerSector 控制。
export function selectLowCorrelationOpportunities(
  ranked = [],
  {
    maxSelections = 8,
    maxPerSector = 2,
    maxPerPlaybook = 3,
    conceptJaccardMax = 0.5,
    eligibleStates = ['READY'],
  } = {},
) {
  const eligibleSet = new Set(eligibleStates)
  const selected = []
  const skipped = []
  const sectorCount = new Map()
  const playbookCount = new Map()

  for (const candidate of Array.isArray(ranked) ? ranked : []) {
    if (!eligibleSet.has(candidate?.state)) {
      skipped.push({ code: candidate?.code, reason: 'STATE_INELIGIBLE' })
      continue
    }
    if (selected.length >= maxSelections) {
      skipped.push({ code: candidate?.code, reason: 'CAPACITY_FULL' })
      continue
    }
    const profile = relationProfile(candidate)
    const sectorUsed = sectorCount.get(profile.sector) || 0
    if (profile.sector && sectorUsed >= maxPerSector) {
      skipped.push({ code: candidate?.code, reason: 'SECTOR_LIMIT' })
      continue
    }
    const playbookUsed = playbookCount.get(profile.playbook) || 0
    if (profile.playbook && playbookUsed >= maxPerPlaybook) {
      skipped.push({ code: candidate?.code, reason: 'PLAYBOOK_LIMIT' })
      continue
    }
    const clash = selected.some((entry) =>
      highlyCorrelated(entry.profile, profile, { conceptJaccardMax }),
    )
    if (clash) {
      skipped.push({ code: candidate?.code, reason: 'HIGH_CORRELATION' })
      continue
    }
    selected.push({ candidate, profile })
    if (profile.sector) {
      sectorCount.set(profile.sector, sectorUsed + 1)
    }
    if (profile.playbook) {
      playbookCount.set(profile.playbook, playbookUsed + 1)
    }
  }

  return {
    schemaVersion: LOW_CORRELATION_SELECTION_VERSION,
    selected: selected.map((entry) => entry.candidate),
    skipped,
    effectiveCount: selected.length,
    sectorBreakdown: Object.fromEntries(sectorCount),
    playbookBreakdown: Object.fromEntries(playbookCount),
  }
}
