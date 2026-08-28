function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function signed(value, digits = 2) {
  const number = finite(value)
  if (number == null) return '--'
  return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}%`
}

function targetPosition(regime = {}) {
  const minimum = finite(regime.targetPositionPct?.min)
  const maximum = finite(regime.targetPositionPct?.max)
  return minimum != null && maximum != null
    ? `${minimum}~${maximum}%`
    : '按军师风险预算'
}

export function buildMarketBoardGuidance({
  regime = {},
  indices = [],
  breadth = {},
  topSector = null,
  limitUp = null,
  limitDown = null,
} = {}) {
  const indexMoves = (Array.isArray(indices) ? indices : [])
    .map((item) => finite(item?.pct))
    .filter((value) => value != null)
  const averageIndexPct = indexMoves.length
    ? indexMoves.reduce((sum, value) => sum + value, 0)
      / indexMoves.length
    : null
  const up = finite(breadth?.up)
  const down = finite(breadth?.down)
  const ratio = down > 0
    ? up / down
    : up > 0 ? 9 : null
  const hasBreadth = up != null && down != null

  let conclusion = '关键盘面数据不足，暂时不能判断市场强弱'
  if (averageIndexPct != null && hasBreadth) {
    if (averageIndexPct <= 0 && ratio >= 1.15) {
      conclusion = '指数偏弱，但多数个股上涨，当前属于结构性赚钱行情'
    } else if (averageIndexPct >= 0 && ratio <= 0.85) {
      conclusion = '指数尚稳，但多数个股下跌，权重护盘不等于普遍好做'
    } else if (averageIndexPct >= 0.3 && ratio >= 1.15) {
      conclusion = '指数与多数个股同步走强，盘面共振较好'
    } else if (averageIndexPct <= -0.3 && ratio <= 0.85) {
      conclusion = '指数与多数个股同步偏弱，亏钱效应正在扩散'
    } else {
      conclusion = '指数与个股表现接近均衡，方向仍需等待确认'
    }
  } else if (averageIndexPct != null) {
    conclusion = averageIndexPct >= 0
      ? '主要指数偏强，但缺少完整涨跌家数验证'
      : '主要指数偏弱，且缺少完整涨跌家数验证'
  } else if (hasBreadth) {
    conclusion = ratio >= 1
      ? '上涨家数占优，但缺少主要指数验证'
      : '下跌家数占优，但缺少主要指数验证'
  }

  const evidence = [
    averageIndexPct == null
      ? ''
      : `主要指数平均${signed(averageIndexPct)}`,
    hasBreadth
      ? `上涨${Math.round(up)}家、下跌${Math.round(down)}家，涨跌比${
          ratio == null ? '暂缺' : ratio.toFixed(2)
        }`
      : '',
    finite(limitUp) != null || finite(limitDown) != null
      ? `涨停${finite(limitUp) ?? '--'}家、跌停${finite(limitDown) ?? '--'}家`
      : '',
    topSector?.name ? `当前强势方向是${topSector.name}` : '',
  ].filter(Boolean).join('；')

  const position = targetPosition(regime)
  const sectorReference = topSector?.name
    ? `${topSector.name}只作为方向线索，`
    : ''
  const action = {
    TREND_STRONG:
      `总仓位控制在${position}；${sectorReference}优先选择资金先行、尚未大涨的个股，不追连续加速。`,
    RANGE:
      `总仓位控制在${position}；以持仓管理和回踩确认低吸为主，不在区间上沿追涨。`,
    TRANSITION:
      `总仓位控制在${position}；${sectorReference}只做资金与买点同时确认的机会，不追已大涨龙头。`,
    RISK_OFF:
      `总仓位降至${position}；暂停普通新增仓位，优先减弱留强并执行止损。`,
    UNKNOWN:
      '暂停新增风险，等指数和涨跌家数恢复后再判断。',
  }[regime?.regime] || '控制仓位，只处理证据完整且价格合理的机会。'

  return {
    tone: {
      TREND_STRONG: 'positive',
      RANGE: 'neutral',
      TRANSITION: 'caution',
      RISK_OFF: 'risk',
      UNKNOWN: 'muted',
    }[regime?.regime] || 'muted',
    icon: regime?.regime === 'RISK_OFF' ? 'shield' : 'gauge',
    conclusion,
    evidence: evidence || '当前可用数据不足',
    action,
  }
}

export function buildSentimentGuidance(input = {}) {
  const score = finite(input.score)
  const limitUp = finite(input.ztCount)
  const broken = finite(input.zbCount)
  const breakRate = finite(input.breakRate)
  const maxBoard = finite(input.maxBoard)
  const linkedBoards = finite(input.lianban)
  const limitDown = finite(input.b?.limitDown)
  const weakSeal = breakRate != null && breakRate >= 35
  const lossSpread = limitDown != null && limitDown >= 10

  let conclusion
  if (weakSeal || lossSpread) {
    conclusion = '市场分歧明显，封板质量下降，亏钱效应正在增加'
  } else if (score != null && score >= 70) {
    conclusion = '赚钱效应较强，接力高度已经打开，但追高风险也在上升'
  } else if (score != null && score >= 55) {
    conclusion = '情绪处于温和修复阶段，可以参与但仍需确认承接'
  } else if (score != null && score >= 40) {
    conclusion = '情绪中性，机会分散，追涨的成功率不高'
  } else if (score != null) {
    conclusion = '情绪偏冷，亏钱效应占优，当前应以防守为主'
  } else {
    conclusion = '情绪数据不足，暂时不能判断赚钱效应'
  }

  const evidence = [
    limitUp == null ? '' : `${Math.round(limitUp)}家涨停`,
    broken == null ? '' : `${Math.round(broken)}家炸板`,
    breakRate == null ? '' : `炸板率${breakRate}%`,
    maxBoard == null ? '' : `最高${Math.round(maxBoard)}板`,
    linkedBoards == null ? '' : `${Math.round(linkedBoards)}只连板股`,
    limitDown == null ? '' : `${Math.round(limitDown)}家跌停`,
  ].filter(Boolean).join('；')

  let action
  if (score == null) {
    action = '暂停依据情绪数据开新仓，等待涨跌停与炸板数据恢复。'
  } else if (weakSeal || lossSpread || score < 40) {
    action = '暂停追涨，已有仓位以减弱留强和止损为主，等炸板率与跌停数量回落。'
  } else if (score >= 70) {
    action = '已有强势仓位可按计划持有或锁利；新开仓不要追涨停和高位加速，只等资金先行的低位启动或回踩确认。'
  } else if (score >= 55) {
    action = '可小仓试错，但必须等资金流入、量价承接和买点同时确认。'
  } else {
    action = '控制交易频率，只观察最强方向中的低位候选，不因单只涨停而追入。'
  }

  return {
    tone: score == null
      ? 'muted'
      : weakSeal || lossSpread || score < 40
      ? 'risk'
      : score >= 70 ? 'caution' : score >= 55 ? 'positive' : 'neutral',
    icon: weakSeal || lossSpread ? 'shield' : 'fire',
    conclusion,
    evidence: evidence || '当前可用情绪数据不足',
    action,
  }
}
