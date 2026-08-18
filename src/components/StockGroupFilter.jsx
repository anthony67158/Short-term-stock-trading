export default function StockGroupFilter({
  dimension = 'concept',
  onDimensionChange,
  groups = [],
  active = '全部',
  onActiveChange,
  total = 0,
  loading = false,
  label = '筛选方式',
  compact = false,
  multiSelect = false,
}) {
  const dimensionLabel = dimension === 'concept' ? '概念' : '行业'
  const activeNames = new Set(
    (Array.isArray(active) ? active : [active]).filter(Boolean),
  )
  const isActive = (name) => activeNames.has(name)
  return (
    <div className={'stock-group-filter' + (compact ? ' compact' : '')}>
      <div className="stock-group-filter-track">
        {compact && <span className="stock-group-filter-label">{label}</span>}
        <div className="stock-group-dimensions" role="group" aria-label="切换概念或行业筛选">
          <button
            type="button"
            className={dimension === 'concept' ? 'on' : ''}
            aria-pressed={dimension === 'concept'}
            onClick={() => onDimensionChange?.('concept')}
          >概念</button>
          <button
            type="button"
            className={dimension === 'industry' ? 'on' : ''}
            aria-pressed={dimension === 'industry'}
            onClick={() => onDimensionChange?.('industry')}
          >行业</button>
        </div>
        <div className="stock-group-tabs-viewport">
          <div className="ind-tabs stock-group-tabs" role="group" aria-label={`按${dimensionLabel}${multiSelect ? '多选' : '筛选'}股票`}>
            <button
              type="button"
              className={'ind-tab' + (isActive('全部') ? ' on' : '')}
              aria-pressed={isActive('全部')}
              onClick={() => onActiveChange?.('全部')}
            >
              全部 <span className="ind-tab-n">{total}</span>
            </button>
            {groups.map((group) => (
              <button
                type="button"
                key={group.name}
                className={'ind-tab' + (isActive(group.name) ? ' on' : '') + (group.name === '其他' ? ' other' : '')}
                aria-pressed={isActive(group.name)}
                onClick={() => onActiveChange?.(group.name)}
              >
                {group.name} <span className="ind-tab-n">{group.count}</span>
                {group.avgPct != null && (
                  <span className={'ind-tab-pct ' + (group.avgPct >= 0 ? 'red' : 'green')}>
                    {group.avgPct >= 0 ? '+' : ''}{group.avgPct.toFixed(1)}%
                  </span>
                )}
              </button>
            ))}
          </div>
          {loading && <span className="stock-group-loading" role="status">题材加载中</span>}
        </div>
      </div>
    </div>
  )
}
