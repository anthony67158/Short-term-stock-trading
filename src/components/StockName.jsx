import { openStockDetail } from '../detailStore'

// 全站通用：可点击的股票名（点击弹出个股详情+K线）
// 用法：<StockName code={s.code} name={s.name} /> 或包裹自定义内容 <StockName code name>{children}</StockName>
export default function StockName({ code, name, showCode = true, className = '', children, stopPropagation = false }) {
  if (!code) return <span className={className}>{children || name}</span>
  const onClick = (e) => {
    if (stopPropagation) e.stopPropagation()
    openStockDetail(code, name)
  }
  const onKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onClick(e)
  }
  return (
    <span
      className={'stock-name-link ' + className}
      role="button"
      tabIndex={0}
      aria-label={`查看${name || code}详情与K线`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title="查看详情与K线"
    >
      {children || (
        <>
          {name}
          {showCode && <span className="sub-name" style={{ marginLeft: 4 }}>{code}</span>}
        </>
      )}
    </span>
  )
}
