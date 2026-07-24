import { useState } from 'react'
import SectorPanel from './SectorPanel'
import StockPanel from './StockPanel'
import SectorHistory from './SectorHistory'
import MarketFlow from './MarketFlow'
import Movers from './Movers'
import { usePolling } from '../hooks'

// ============ 盘面研究（次级）：板块/个股下钻/资金流向桑基图 ============
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
      <MarketFlow interval={interval} />
      <div className="grid" style={{ marginTop: 14 }}>
        <SectorPanel
          data={sectors.data} loading={sectors.loading} error={sectors.error}
          type={type} setType={(t) => { setType(t); setSelected(null) }}
          selected={selected} onSelect={setSelected}
        />
        <div>
          <StockPanel sector={selected} data={selected ? stocks.data : null} loading={stocks.loading} error={stocks.error} sort={sort} setSort={setSort} />
          <SectorHistory sector={selected} />
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <Movers interval={interval} />
      </div>
    </div>
  )
}
