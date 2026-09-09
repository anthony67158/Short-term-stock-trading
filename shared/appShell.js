export const APP_SECTIONS = Object.freeze([
  {
    key: 'today',
    label: '今日作战',
    shortLabel: '作战',
    icon: 'radar',
    description: '先处理当前指令，再查看等待条件和今日机会。',
  },
  {
    key: 'plan',
    label: '持仓管理',
    shortLabel: '持仓',
    icon: 'wallet',
    description: '管理持仓、自选、执行计划与真实成交。',
  },
  {
    key: 'hub',
    label: '交易复盘',
    shortLabel: '复盘',
    icon: 'gauge',
    description: '核对资产、预警、交易记录与执行质量。',
  },
])

export function resolveWorkspaceLocation(tab, sub) {
  if (tab === 'research') return { tab: 'today', sub: 'research' }
  if (tab === 'hub' && sub === 'account') return { tab: 'plan', sub: 'account' }
  if (tab === 'plan') return { tab, sub: sub === 'account' ? 'account' : 'positions' }
  if (tab === 'hub') return { tab, sub: sub === 'alert' ? 'alert' : 'review' }
  return { tab: 'today', sub: sub === 'research' ? 'research' : 'selection' }
}

const TAB_BY_KEY = Object.freeze(
  Object.fromEntries(
    APP_SECTIONS.map((section, index) => [
      String(index + 1),
      section.key,
    ]),
  ),
)

export function resolveAppShortcut({
  key = '',
  metaKey = false,
  ctrlKey = false,
  altKey = false,
  typing = false,
} = {}) {
  if (key === 'Escape') return { type: 'escape' }
  if (altKey) return null
  if (
    String(key).toLowerCase() === 'k'
    && (metaKey || ctrlKey)
  ) {
    return { type: 'assistant' }
  }
  if (metaKey || ctrlKey || typing) return null
  if (TAB_BY_KEY[key]) {
    return { type: 'tab', tab: TAB_BY_KEY[key] }
  }
  if (key === '/' || key === 'a' || key === 'A') {
    return { type: 'assistant' }
  }
  return null
}
