export const APP_SECTIONS = Object.freeze([
  {
    key: 'today',
    label: '今日决策',
    shortLabel: '决策',
    icon: 'radar',
    description: '先看环境与军师结论，再决定今天是否出手。',
  },
  {
    key: 'plan',
    label: '持仓执行',
    shortLabel: '持仓',
    icon: 'wallet',
    description: '管理持仓、自选、做 T 与价格触发计划。',
  },
  {
    key: 'hub',
    label: '账户闭环',
    shortLabel: '账户',
    icon: 'gauge',
    description: '核对资产、预警、交易记录与执行质量。',
  },
  {
    key: 'research',
    label: '盘面研究',
    shortLabel: '研究',
    icon: 'layers',
    description: '下钻资金、板块、异动、龙虎榜与宏观证据。',
  },
])

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
