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
