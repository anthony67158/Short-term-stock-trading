import { useRef, useState } from 'react'
import SectorPanel from './SectorPanel'
import StockPanel from './StockPanel'
import SectorHistory from './SectorHistory'
import SectorForecast from './SectorForecast'
import ConceptTrendPanel from './ConceptTrendPanel'
import MarketFlow from './FundFlowCanvas'
import Movers from './Movers'
import LhbBoard from './LhbBoard'
import MarketNews from './MarketNews'
import ErrorBoundary from './ErrorBoundary'
import { usePolling } from '../hooks'

// ============ 盘面研究（次级）：大盘资金流向 + 板块/个股下钻 ============
export default function ResearchTab({ interval }) {
  const [type, setType] = useState('industry')
  const [selected, setSelected] = useState(null)
  const [sort, setSort] = useState('pct')
  const constituentsRef = useRef(null)

  const sectors = usePolling(`/api/sectors?type=${type}&sort=main`, interval, [type])
  const stocks = usePolling(
    selected ? `/api/stocks?code=${selected.code}&sort=${sort}` : null,
    interval,
    [selected && selected.code, sort]
  )
  const inspectConstituents = (sector) => {
    setType('concept')
    setSelected(sector)
    requestAnimationFrame(() => {
      const target = constituentsRef.current
      if (!target) return
      const reduceMotion = window.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches
      target.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      })
      target.focus({ preventScroll: true })
    })
  }

  return (
    <div className="research">
      <ErrorBoundary label="板块前瞻">
        <SectorForecast />
      </ErrorBoundary>
      <ErrorBoundary label="概念走势">
        <ConceptTrendPanel
          interval={interval}
          onInspect={inspectConstituents}
        />
      </ErrorBoundary>
      <ErrorBoundary label="资金流向图"><MarketFlow interval={interval} /></ErrorBoundary>
      <div className="grid research-grid">
        <ErrorBoundary label="板块资金">
          <SectorPanel
            data={sectors.data} loading={sectors.loading} error={sectors.error}
            type={type} setType={(t) => { setType(t); setSelected(null) }}
            selected={selected} onSelect={setSelected}
          />
        </ErrorBoundary>
        <div
          ref={constituentsRef}
          className="research-stack research-drilldown"
          tabIndex="-1"
          aria-label={selected ? `${selected.name}成分股明细` : '成分股明细'}
        >
          <ErrorBoundary label="成分股"><StockPanel sector={selected} data={selected ? stocks.data : null} loading={stocks.loading} error={stocks.error} sort={sort} setSort={setSort} /></ErrorBoundary>
          <ErrorBoundary label="板块历史"><SectorHistory sector={selected} /></ErrorBoundary>
        </div>
      </div>
      <div className="research-section">
        <ErrorBoundary label="盘中异动"><Movers interval={interval} /></ErrorBoundary>
      </div>
      <div className="research-section">
        <ErrorBoundary label="游资龙虎榜"><LhbBoard interval={interval} /></ErrorBoundary>
      </div>
      <div className="research-section">
        <ErrorBoundary label="外部宏观经济分析"><MarketNews /></ErrorBoundary>
      </div>
    </div>
  )
}
