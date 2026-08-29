export const FORMULA_PRICE_NAMES = Object.freeze({
  INTRADAY_VWAP_PULLBACK: '盘中回踩承接',
  INTRADAY_ACCUMULATION: '盘中资金先行',
  CLOSE_TREND_PULLBACK: '收盘趋势回踩',
  CLOSE_SQUEEZE: '收盘蓄势突破',
  HOLDING_RISK_POLICY: '持仓风险纪律',
})

const GENERIC_NO_MATCH = new Set([
  '当前没有公式形成有效主路径',
])

function cleanList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  )]
}

function formulaName(evaluation = {}) {
  return String(
    evaluation.name
    || FORMULA_PRICE_NAMES[evaluation.formulaId]
    || '当前公式',
  )
}

function directReasonTitle(reasons, matched) {
  if (reasons.some((item) => /关键行情|过期/.test(item))) {
    return '关键数据不足，暂时不能定价'
  }
  if (reasons.some((item) => /市场|账户/.test(item))) {
    return '市场或账户条件暂不允许买入'
  }
  if (
    matched
    || reasons.some((item) => /价位|价带|盈亏比/.test(item))
  ) {
    return '公式已命中，但价格风控未通过'
  }
  return '当前条件不足，暂不买入'
}

export function buildFormulaPriceExplanation(payload = {}) {
  const decision = payload?.decision || null
  const evaluations = Array.isArray(payload?.formula?.evaluations)
    ? payload.formula.evaluations
    : []
  const computed = !!decision || evaluations.length > 0
  const modeLabel = payload?.formula?.mode === 'INTRADAY'
    ? '盘中'
    : payload?.formula?.mode === 'CLOSE'
      ? '收盘'
      : ''
  const status = computed
    ? evaluations.length
      ? `已完成${evaluations.length}条${modeLabel}公式检查`
      : '已完成规则检查'
    : '尚未完成公式计算'
  if (!decision) {
    return {
      computed,
      status,
      title: '暂时无法判断',
      formulaName: '公式状态未知',
      reasons: [],
      moreCount: 0,
      alternative: '',
    }
  }

  const matched = evaluations.find((item) => item?.matched) || null
  const directReasons = cleanList(decision.blockers)
    .filter((item) => !GENERIC_NO_MATCH.has(item))
  if (decision.action !== 'AVOID') {
    return {
      computed,
      status,
      title: '',
      formulaName:
        FORMULA_PRICE_NAMES[decision.formulaId]
        || formulaName(matched || {}),
      reasons: directReasons,
      moreCount: 0,
      alternative: '',
    }
  }

  if (directReasons.length) {
    return {
      computed,
      status,
      title: directReasonTitle(directReasons, matched),
      formulaName:
        FORMULA_PRICE_NAMES[decision.formulaId]
        || formulaName(matched || {}),
      reasons: directReasons.slice(0, 5),
      moreCount: Math.max(0, directReasons.length - 5),
      alternative: '',
    }
  }

  const ranked = evaluations
    .filter((item) => !item?.matched)
    .map((item) => ({
      ...item,
      blockers: cleanList(item?.blockers),
    }))
    .sort((left, right) =>
      left.blockers.length - right.blockers.length
      || formulaName(left).localeCompare(formulaName(right), 'zh-CN')
    )
  const nearest = ranked[0] || null
  const reasons = nearest?.blockers || []
  const alternative = ranked[1]
    ? `${formulaName(ranked[1])}还差${ranked[1].blockers.length}项`
    : ''
  return {
    computed,
    status,
    title: nearest
      ? `最接近“${formulaName(nearest)}”，还差${reasons.length}项`
      : '当前没有公式形成有效主路径',
    formulaName: nearest ? formulaName(nearest) : '公式条件未成立',
    reasons: reasons.slice(0, 5),
    moreCount: Math.max(0, reasons.length - 5),
    alternative,
  }
}
