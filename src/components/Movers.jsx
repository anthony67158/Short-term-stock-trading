import { useState } from 'react'
import { usePolling } from '../hooks'
import Icon from './Icon'
import StockName from './StockName'
import { fmtPct, pctClass, fmtInflow, fmtNum , fmtRaw } from '../format'

export default function Movers({ interval }) {
  const [kind, setKind] = useState('inflow') // inflow | speed | outflow
  const { data, loading, error } = usePolling(`/api/board?type=movers&kind=${kind}`, interval, [kind])
  const list = (data && data.list) || []

  return (
    <div className="panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="bolt" size={16} /> 盘中异动监控 <span className="sub-name">全市场</span></div>
        <div className="tabs">
          <button type="button" className={'tab' + (kind === 'inflow' ? ' active' : '')} aria-pressed={kind === 'inflow'} onClick={() => setKind('inflow')}>主力抢筹</button>
          <button type="button" className={'tab' + (kind === 'speed' ? ' active' : '')} aria-pressed={kind === 'speed'} onClick={() => setKind('speed')}>涨速榜</button>
          <button type="button" className={'tab' + (kind === 'outflow' ? ' active' : '')} aria-pressed={kind === 'outflow'} onClick={() => setKind('outflow')}>主力出逃</button>
        </div>
      </div>
      {loading && !data ? (
        <div className="loading">加载中…</div>
      ) : list.length === 0 ? (
        <div className="empty">{error ? '数据源暂不可用，稍后自动重试…' : '暂无数据'}</div>
      ) : (
        <div className="scroll" style={{ maxHeight: 360 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th><th>现价</th><th>涨跌幅</th>
                {kind === 'speed' ? <th>涨速</th> : <th>换手</th>}
                <th>主力净流入</th><th>净占比</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s, i) => (
                <tr key={s.code}>
                  <td><span className="rank">{i + 1}</span><StockName code={s.code} name={s.name} />{s.isLimitUp && <span className="tag tag-lu">涨停</span>}</td>
                  <td>{fmtRaw(s.price)}</td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  {kind === 'speed'
                    ? <td className={pctClass(s.speed)}>{fmtNum(s.speed, 2)}%</td>
                    : <td className={s.turnover > 10 ? 'gold' : ''}>{fmtNum(s.turnover, 1)}%</td>}
                  <td className={pctClass(s.mainInflow)}>{fmtInflow(s.mainInflow)}</td>
                  <td className={pctClass(s.mainRatio)}>{fmtNum(s.mainRatio, 1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="legend" style={{ padding: '8px 12px' }}>
            {kind === 'inflow' && '主力资金正在大额买入的个股，往往是当日热点方向'}
            {kind === 'speed' && '短时间内快速拉升的个股，注意甄别真突破还是脉冲'}
            {kind === 'outflow' && '主力大额流出，持有需警惕，避免接盘'}
          </div>
        </div>
      )}
    </div>
  )
}
