import { useState } from 'react'
import { usePolling } from '../hooks'
import Icon from './Icon'
import StockName from './StockName'
import { fmtPct, pctClass, fmtNum, fmtRaw } from '../format'

// 金额：元 → 亿/万 自适应，带正负号（A股口径：红买入/绿卖出由外层 class 控制）
function money(v) {
  const a = Math.abs(v || 0)
  const s = v < 0 ? '-' : ''
  if (a >= 1e8) return s + (a / 1e8).toFixed(2) + '亿'
  if (a >= 1e4) return s + (a / 1e4).toFixed(0) + '万'
  return s + a.toFixed(0)
}
function signMoney(v) { return (v > 0 ? '+' : '') + money(v) }

// 上榜原因精简（去掉“的前5只证券”等冗长后缀，便于表格展示）
function shortReason(r) {
  if (!r) return '—'
  return r
    .replace(/的前\d+只证券/g, '')
    .replace(/连续三个交易日内，/g, '3日')
    .replace(/日涨幅偏离值达到7%/g, '涨幅偏离7%')
    .replace(/日跌幅偏离值达到7%/g, '跌幅偏离7%')
    .replace(/涨幅偏离值累计达到20%的证券/g, '3日涨20%')
    .replace(/跌幅偏离值累计达到20%的证券/g, '3日跌20%')
    .replace(/日振幅值达到15%/g, '振幅15%')
    .replace(/日换手率达到20%/g, '换手20%')
    .replace(/日涨幅达到15%/g, '涨15%')
    .replace(/日跌幅达到15%/g, '跌15%')
    .trim()
}

export default function LhbBoard({ interval }) {
  const [tab, setTab] = useState('stocks') // stocks 上榜个股 | seats 活跃游资
  // 龙虎榜收盘后更新，无需高频轮询；给一个较长间隔
  const pollMs = Math.max(interval || 15000, 300000)
  const { data, loading, error } = usePolling('/api/board?type=lhb', pollMs, [])
  const stocks = (data && data.stocks) || []
  const seats = (data && data.seats) || []
  const date = data && data.date

  return (
    <div className="panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="trophy" size={16} /> 游资龙虎榜
          <span className="sub-name">{date ? date : '收盘后更新'}</span>
        </div>
        <div className="tabs">
          <button type="button" className={'tab' + (tab === 'stocks' ? ' active' : '')} aria-pressed={tab === 'stocks'} onClick={() => setTab('stocks')}>上榜个股</button>
          <button type="button" className={'tab' + (tab === 'seats' ? ' active' : '')} aria-pressed={tab === 'seats'} onClick={() => setTab('seats')}>活跃游资</button>
        </div>
      </div>

      {loading && !data ? (
        <div className="loading">加载中…</div>
      ) : error && !data ? (
        <div className="empty">数据源暂不可用，稍后自动重试…</div>
      ) : tab === 'stocks' ? (
        stocks.length === 0 ? (
          <div className="empty">暂无龙虎榜数据</div>
        ) : (
          <div className="scroll" style={{ maxHeight: 420 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称</th><th>现价</th><th>涨跌幅</th><th>换手</th>
                  <th>龙虎榜净额</th><th>上榜原因</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((s, i) => (
                  <tr key={`${s.code}:${i}`}>
                    <td><span className="rank">{i + 1}</span><StockName code={s.code} name={s.name} /></td>
                    <td>{fmtRaw(s.price)}</td>
                    <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                    <td className={s.turnover > 20 ? 'gold' : ''}>{fmtNum(s.turnover, 1)}%</td>
                    <td className={pctClass(s.net)}>{signMoney(s.net)}</td>
                    <td className="lhb-reason">{shortReason(s.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="legend" style={{ padding: '8px 12px' }}>
              红色净额=买方主导（资金净买入），绿色=卖方主导；龙虎榜为收盘后复盘数据，适合隔日短线参考
            </div>
          </div>
        )
      ) : seats.length === 0 ? (
        <div className="empty">暂无席位数据</div>
      ) : (
        <div className="scroll" style={{ maxHeight: 420 }}>
          <div className="lhb-seats">
            {seats.map((s, i) => (
              <div className="lhb-seat" key={s.name}>
                <div className="lhb-seat-head">
                  <span className="rank">{i + 1}</span>
                  <div className="lhb-seat-name">
                    <div className="lhb-seat-title">
                      {s.alias && <span className="lhb-alias">{s.alias}</span>}
                      <span className="lhb-dept" title={s.name}>{s.name}</span>
                    </div>
                  </div>
                  <span className={'lhb-seat-net ' + pctClass(s.net)}>{signMoney(s.net)}</span>
                </div>
                {s.picks && s.picks.length > 0 && (
                  <div className="lhb-picks">
                    {s.picks.map((p) => (
                      <span className="lhb-pick" key={p.code}>
                        <StockName code={p.code} name={p.name} stopPropagation><span>{p.name}</span></StockName>
                        <b className="red">{signMoney(p.net)}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="legend" style={{ padding: '8px 12px' }}>
            按买方营业部当日净买额聚合，展示今日最活跃的游资/机构席位及其主买个股；含北向（沪深股通）与机构专用席位
          </div>
        </div>
      )}
    </div>
  )
}
