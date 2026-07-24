import { fmtPct, pctClass, fmtInflow, timeStr } from '../format'

export default function Sentiment({ data, error }) {
  const indices = (data && data.indices) || []
  const b = (data && data.breadth) || {}
  const upW = b.total ? (b.up / b.total) * 100 : 50
  const downW = b.total ? (b.down / b.total) * 100 : 50
  const ratio = b.down ? (b.up / b.down).toFixed(2) : '--'

  return (
    <div className="sentiment">
      {indices.map((idx) => (
        <div className="card" key={idx.code}>
          <div className="label">{idx.name}</div>
          <div className={'val ' + pctClass(idx.pct)}>{idx.price.toFixed(2)}</div>
          <div className={'sub ' + pctClass(idx.pct)}>
            {fmtPct(idx.pct)} {idx.chg >= 0 ? '+' : ''}{idx.chg.toFixed(2)}
          </div>
        </div>
      ))}

      <div className="card">
        <div className="label">涨 / 跌 家数</div>
        <div className="val">
          <span className="red">{b.up ?? '--'}</span>
          <span style={{ color: 'var(--muted)' }}> / </span>
          <span className="green">{b.down ?? '--'}</span>
        </div>
        <div className="sub">涨跌比 {ratio}</div>
        <div className="breadth-bar">
          <div className="up" style={{ width: upW + '%' }} />
          <div className="down" style={{ width: downW + '%' }} />
        </div>
      </div>

      <div className="card">
        <div className="label">涨停 / 跌停</div>
        <div className="val">
          <span className="red">{b.limitUp ?? '--'}</span>
          <span style={{ color: 'var(--muted)' }}> / </span>
          <span className="green">{b.limitDown ?? '--'}</span>
        </div>
        <div className="sub">
          {error ? <span className="err">数据源波动</span> : `更新 ${data ? timeStr(data.updatedAt) : '--'}`}
        </div>
      </div>
    </div>
  )
}
