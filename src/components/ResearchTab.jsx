import { useState } from 'react'
import SectorPanel from './SectorPanel'
import StockPanel from './StockPanel'
import SectorHistory from './SectorHistory'
import MarketFlow from './MarketFlow'
import Movers from './Movers'
import LhbBoard from './LhbBoard'
import ErrorBoundary from './ErrorBoundary'
import { usePolling } from '../hooks'

// ============ 盘面研究（次级）：大盘资金流向 + 板块/个股下钻 ============
export default function ResearchTab({ interval }) {
  const [type, setType] = useState('industry')
  const [selected, setSelected] = useState(null)
  const [sort, setSort] = useState('pct')

  const sectors = usePolling(`/api/sectors?type=${type}&sort=main`, interval, [type])
  const stocks = usePolling(
    selected ? `/api/stocks?code=${selected.code}&sort=${sort}` : null,
    interval,
    [selected && selected.code, sort]
  )

  return (
    <div className="research">
      <ErrorBoundary label="资金流向图"><MarketFlow interval={interval} /></ErrorBoundary>
      <div className="grid" style={{ marginTop: 14 }}>
        <ErrorBoundary label="板块资金">
          <SectorPanel
            data={sectors.data} loading={sectors.loading} error={sectors.error}
            type={type} setType={(t) => { setType(t); setSelected(null) }}
            selected={selected} onSelect={setSelected}
          />
        </ErrorBoundary>
        <div>
          <ErrorBoundary label="成分股"><StockPanel sector={selected} data={selected ? stocks.data : null} loading={stocks.loading} error={stocks.error} sort={sort} setSort={setSort} /></ErrorBoundary>
          <ErrorBoundary label="板块历史"><SectorHistory sector={selected} /></ErrorBoundary>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <ErrorBoundary label="盘中异动"><Movers interval={interval} /></ErrorBoundary>
      </div>
      <div style={{ marginTop: 14 }}>
        <ErrorBoundary label="游资龙虎榜"><LhbBoard interval={interval} /></ErrorBoundary>
      </div>
    </div>
  )
}
