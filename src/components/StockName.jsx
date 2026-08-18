import { openStockDetail } from '../detailStore'
import StockTags from './StockTags'

// 全站通用：可点击的股票名（点击弹出个股详情+K线）
// 用法：<StockName code={s.code} name={s.name} /> 或包裹自定义内容 <StockName code name>{children}</StockName>
export default function StockName({
  code,
  name,
  showCode = true,
  showTags = true,
  industry = '',
  className = '',
  children,
  stopPropagation = false,
  interactive = true,
}) {
  if (!code) return <span className={className}>{children || name}</span>
  const onClick = (e) => {
    if (stopPropagation) e.stopPropagation()
    openStockDetail(code, name)
  }
  const primary = (
    <span className="stock-name-primary">
      <span className="stock-name-text">{children || name}</span>
      {showCode && <span className="stock-name-code">{code}</span>}
    </span>
  )
  const identity = (
    <>
      {primary}
      {showTags && (
        <StockTags code={code}
          fallbackIndustry={industry}
          variant="stacked"
        />
      )}
    </>
  )
  return (
    <span className="stock-name-cluster">
      {interactive ? (
        <button
          type="button"
          className={'stock-name-link ' + className}
          aria-label={`查看${name || code}详情与K线`}
          onClick={onClick}
          title="查看详情与K线"
        >
          {identity}
        </button>
      ) : (
        <span className={'stock-name-static ' + className}>
          {identity}
        </span>
      )}
    </span>
  )
}
