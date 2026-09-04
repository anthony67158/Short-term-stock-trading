import Icon from './Icon'

const MODES = Object.freeze([
  {
    id: 'ready',
    label: '可立即买入',
    shortLabel: '立即买入',
    detail: '条件全部通过',
    icon: 'target',
  },
  {
    id: 'layout',
    label: '今日提前布局',
    shortLabel: '提前布局',
    detail: '等待触发或风险解除',
    icon: 'clock',
  },
  {
    id: 'tail',
    label: '尾盘反转',
    shortLabel: '尾盘反转',
    detail: '14:50自动扫描',
    icon: 'history',
  },
])

export default function OpportunityIntradayNav({
  active,
  counts = {},
  onChange,
}) {
  return (
    <div
      className="opportunity-intraday-nav"
      role="tablist"
      aria-label="盘中机会分类"
    >
      {MODES.map((mode) => {
        const selected = active === mode.id
        const count = Math.max(0, Number(counts[mode.id]) || 0)
        return (
          <button
            type="button"
            role="tab"
            id={`opportunity-intraday-tab-${mode.id}`}
            aria-selected={selected}
            aria-controls="opportunity-intraday-panel"
            className={selected ? 'active' : ''}
            data-mode={mode.id}
            key={mode.id}
            onClick={() => onChange(mode.id)}
          >
            <Icon name={mode.icon} size={15} />
            <span>
              <b>{mode.label}</b>
              <small>{mode.detail}</small>
            </span>
            <strong aria-label={`${mode.shortLabel}${count}只`}>
              {count}
            </strong>
          </button>
        )
      })}
    </div>
  )
}
