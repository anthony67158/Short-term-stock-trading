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

export function adviceGenerationAction({
  loading = false,
  hasAdvice = false,
} = {}) {
  if (loading) {
    return {
      label: '军师生成中…',
      icon: 'refresh',
      disabled: true,
    }
  }
  return {
    label: hasAdvice
      ? '重新生成军师 AI 操作建议'
      : '军师生成 AI 操作建议',
    icon: hasAdvice ? 'refresh' : 'spark',
    disabled: false,
  }
}
