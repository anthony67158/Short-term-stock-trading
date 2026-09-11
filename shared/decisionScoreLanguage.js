function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rate(value) {
  const number = finite(value)
  return number != null && number >= 0 && number <= 1
    ? number
    : null
}

function countPerHundred(value) {
  return Math.round(value * 100)
}

function probabilityText(value) {
  return `${(value * 100).toFixed(1)}%`
}

function riskResult(value, prefix) {
  const amount = Math.abs(value).toFixed(2)
  if (value > 0) return `${prefix}赚${amount}份`
  if (value < 0) return `${prefix}亏${amount}份`
  return `${prefix}接近不赚不亏`
}

export function decisionScoreLanguage(score = {}) {
  const fill = rate(score.pFill)
  const win = rate(score.pWinGivenFill)
  const expected = finite(score.expectedNetR)
  const tail = finite(score.expectedShortfall10)
  const items = []

  if (fill != null) {
    items.push({
      key: 'fill',
      label: '能否成交',
      text:
        `类似机会每100次触发，约${countPerHundred(fill)}次能按计划成交`
        + `（原始值${probabilityText(fill)}）。`,
    })
  }
  if (win != null) {
    const wins = countPerHundred(win)
    items.push({
      key: 'win',
      label: '成交以后',
      text:
        `每100笔成交约${wins}笔费后盈利、${100 - wins}笔未盈利`
        + `（原始值${probabilityText(win)}）。`,
    })
  }
  if (expected != null) {
    items.push({
      key: 'expected',
      label: '长期平均',
      text:
        `${riskResult(expected, '扣除手续费和滑点后，每承担1份计划风险，平均预计')}`
        + '。',
    })
  }
  if (tail != null) {
    items.push({
      key: 'tail',
      label: '不利情形',
      text:
        `在表现最差的10%情形中，${riskResult(tail, '平均可能')}`
        + '计划风险。',
    })
  }

  const summary = items.map((item) => item.text).join('')
  return {
    items,
    summary,
    riskUnitNote: expected != null || tail != null
      ? '1份计划风险（1R）指参考执行价到止损价之间的预设损失。'
      : '',
  }
}
