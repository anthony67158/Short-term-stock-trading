const GENERIC_MARKET_BLOCKERS = new Set([
  '当前盘面不允许新增风险',
  '当前市场环境不支持新增风险',
])
const LEGACY_EXPLANATIONS = new Map([
  [
    '板块方向需要重新确认',
    '板块快照不是当前交易时段最新结果，重新扫描后再判断',
  ],
  [
    '板块方向尚未支持新增仓位',
    '所属板块当前只允许观察，尚未达到可布局或回踩介入状态',
  ],
  [
    '买卖价格合同不完整',
    '缺少入场价、止损价、目标价或有效时限，不能形成完整交易计划',
  ],
  [
    '公式结果已过期',
    '公式结果不属于当前交易日，重新扫描前不作为买入依据',
  ],
  [
    '公式观察时段已结束',
    '该公式的有效观察时间已经结束，本轮不再追价',
  ],
  [
    '手动试算仅供观察',
    '这是手动试算结果，不会生成正式买入指令',
  ],
  [
    '尾盘结果已过期',
    '尾盘结果不属于当前交易日，不能用于今天执行',
  ],
  [
    '尾盘买卖计划不完整',
    '尾盘候选缺少入场价、止损价或最晚退出日，不能执行',
  ],
  [
    '核心指数与市场广度均未形成可参与结构',
    '核心指数趋势和上涨/下跌家数均未达到开新仓要求',
  ],
  [
    '板块方向未确认',
    '所属行业或概念未进入今日板块前瞻确认范围',
  ],
  [
    '资金承接未确认',
    '主力当日或近5日净流入没有转正，暂未看到持续承接',
  ],
  [
    '主力资金未确认',
    '主力当日或近5日净流入没有转正，暂未看到持续承接',
  ],
  [
    '最近分钟线未确认承接',
    '最近分钟价格尚未持续站稳分时均价线，或出现明显回落',
  ],
])

function clean(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
}

export function explainOpportunityBlockers(values = [], limit = 2) {
  const blockers = opportunityBlockerDetails(values)
  const specific = blockers.filter(
    (value) => !GENERIC_MARKET_BLOCKERS.has(value),
  )
  if (specific.length) {
    return specific.slice(0, Math.max(1, limit)).join('；')
  }
  if (blockers.some((value) => GENERIC_MARKET_BLOCKERS.has(value))) {
    return '市场风险条件未通过，暂停新增仓位；'
      + '已有持仓仍按止损和退出计划处理'
  }
  return '当前证据不足，暂不新增仓位；条件变化后重新扫描'
}

export function opportunityBlockerDetails(values = []) {
  return clean(values).map(
    (value) => LEGACY_EXPLANATIONS.get(value) || value,
  )
}

export function explainOpportunityMarketGate(gate = {}) {
  if (!gate || gate.allowed === true) return []
  const reasons = []
  const score = Number(gate.regime?.score)
  if (Number.isFinite(score)) {
    reasons.push(
      `市场综合强度${score}分，当前为${
        gate.regime?.label || '防守状态'
      }`,
    )
  }
  const weakIndices = (Array.isArray(gate.indices) ? gate.indices : [])
    .map((item) => {
      const issues = [
        item.aboveMa20 === false ? '低于20日线' : null,
        item.belowMa60 === true ? '低于60日线' : null,
        item.bullishStack === false ? '均线未形成多头' : null,
      ].filter(Boolean)
      return issues.length
        ? `${item.name || item.code}${issues.join('、')}`
        : null
    })
    .filter(Boolean)
  if (weakIndices.length) {
    reasons.push(`核心指数趋势未确认：${weakIndices.join('；')}`)
  }
  const specific = clean(gate.blockers).filter(
    (value) => !GENERIC_MARKET_BLOCKERS.has(value),
  )
  reasons.push(...specific)
  return clean(reasons)
}
