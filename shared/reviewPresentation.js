function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function reviewTerminology(simulation = false) {
  return simulation
    ? {
        executionLabel: '模拟执行',
        executionDescription:
          '系统决策不等于模拟操作，只统计隔离账本中的已记录成交',
        emptyExecution:
          '生成系统决策并记录模拟买卖后，这里会显示决策采纳与执行关联。',
        selectionDescription:
          '当前模拟账本中的费后卖出结果，按首次选股来源归类；部分卖出不作为独立回合。',
        emptySelection: '当前没有可核对的模拟卖出记录',
      }
    : {
        executionLabel: '真实执行',
        executionDescription:
          '系统决策不等于真实操作，只统计实际落账',
        emptyExecution:
          '生成系统决策并记录真实买卖后，这里会显示决策采纳与执行关联。',
        selectionDescription:
          '当前账本中的真实费后卖出结果，按首次选股来源归类；部分卖出不作为独立回合。',
        emptySelection: '当前没有可核对的真实卖出记录',
      }
}

export function expectationCaption(value) {
  const number = finite(value)
  if (number == null) return '每笔平均结果'
  if (number > 0) return '每笔平均盈利'
  if (number < 0) return '每笔平均亏损'
  return '每笔平均持平'
}

export function executionProgressLabel(plan = {}) {
  const target = Math.max(0, Math.trunc(finite(plan.targetLots) || 0))
  const filled = Math.max(
    0,
    Math.min(target, Math.trunc(finite(plan.filledLots) || 0)),
  )
  if (filled > 0 || plan.status === 'COMPLETED') {
    return `已成交 ${filled}/${target}手`
  }
  return `未成交 · 原计划${target}手`
}
