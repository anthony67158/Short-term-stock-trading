export const APP_SECTIONS = Object.freeze([
  {
    key: 'today',
    label: '市场与选股',
    shortLabel: '选股',
    icon: 'radar',
    description: '先看环境与军师结论，再决定今天是否出手。',
  },
  {
    key: 'plan',
    label: '交易与持仓',
    shortLabel: '交易',
    icon: 'wallet',
    description: '管理持仓、自选、做 T 与价格触发计划。',
  },
  {
    key: 'hub',
    label: '复盘与改进',
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
