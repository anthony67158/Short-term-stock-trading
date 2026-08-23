export function stockWatchAction({
  inWatchlist = false,
  isHeld = false,
} = {}) {
  if (isHeld) {
    return {
      label: '持仓中',
      icon: 'check',
      disabled: true,
      active: true,
    }
  }
  if (inWatchlist) {
    return {
      label: '取消自选',
      icon: 'starFill',
      disabled: false,
      active: true,
    }
  }
  return {
    label: '加入自选',
    icon: 'star',
    disabled: false,
    active: false,
  }
}

export function adviceGenerationActions({
  loading = false,
  deepMode = false,
} = {}) {
  const quickActive = loading && deepMode !== true
  const deepActive = loading && deepMode === true
  return {
    quick: {
      label: quickActive ? '快速生成中' : '快速生成',
      icon: quickActive ? 'refresh' : 'spark',
      disabled: loading,
      active: quickActive,
    },
    deep: {
      label: deepActive ? '深度生成中' : '深度生成',
      icon: deepActive ? 'refresh' : 'brain',
      disabled: loading,
      active: deepActive,
    },
  }
}

const ADVICE_MODE_GUIDANCE_ITEMS = Object.freeze([
  { key: 'deep', icon: 'brain', label: '深度生成', purpose: '定计划' },
  { key: 'quick', icon: 'spark', label: '快速生成', purpose: '看变化' },
  { key: 'judge', icon: 'bell', label: '盯盘 Judge', purpose: '定时机' },
  {
    key: 'discipline',
    icon: 'shield',
    label: '止损纪律',
    purpose: '优先于 AI',
  },
])

export function adviceModeGuidance({ hasAdvice = false } = {}) {
  const firstGeneration = hasAdvice !== true
  return {
    firstGeneration,
    deepBadge: firstGeneration ? '首次推荐' : '',
    deepUseCase: '建仓·明显加仓·隔夜前',
    deepTitle:
      '首次生成、准备建仓、计划明显提高仓位或决定隔夜持有时，优先使用深度生成',
    items: ADVICE_MODE_GUIDANCE_ITEMS,
  }
}
