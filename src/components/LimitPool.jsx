import { useState } from 'react'
import { usePolling } from '../hooks'
import Icon from './Icon'
import StockName from './StockName'
import { fmtPct, pctClass, fmtInflow } from '../format'

function fmtTime(t) {
  if (!t) return '--'
  const s = String(t).padStart(6, '0')
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`
}

export default function LimitPool({ interval }) {
  const [kind, setKind] = useState('zt') // zt | zb
  const { data, loading, error } = usePolling(`/api/board?type=limitup&kind=${kind}`, interval, [kind])
  const list = (data && data.list) || []

  // 连板梯队统计（仅涨停池）
  const ladders = {}
  if (kind === 'zt') {
    for (const s of list) {
      const k = s.lbc >= 1 ? s.lbc : 1
      ladders[k] = (ladders[k] || 0) + 1
    }
  }
  const ladderKeys = Object.keys(ladders).map(Number).sort((a, b) => b - a)

  return (
    <section className="panel limit-pool">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="rocket" size={16} /> 涨停连板池
          {kind === 'zt' && list.length > 0 && (
            <span className="sub-name">今日涨停 {list.length} 家</span>
          )}
        </div>
        <div className="tabs">
          <button type="button" className={'tab' + (kind === 'zt' ? ' active' : '')} aria-pressed={kind === 'zt'} onClick={() => setKind('zt')}>涨停池</button>
          <button type="button" className={'tab' + (kind === 'zb' ? ' active' : '')} aria-pressed={kind === 'zb'} onClick={() => setKind('zb')}>炸板池</button>
        </div>
      </div>

      {kind === 'zt' && ladderKeys.length > 0 && (
        <div style={{ padding: '8px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
          {ladderKeys.map((k) => (
            <span key={k} className="tag tag-lu" style={{ fontSize: 12, padding: '3px 8px' }}>
              {k >= 2 ? `${k}连板` : '首板'} · {ladders[k]}
            </span>
          ))}
        </div>
      )}

      {loading && !data ? (
        <div className="loading">加载中…</div>
      ) : list.length === 0 ? (
        <div className="empty">
          {error ? '数据源暂不可用，稍后自动重试…' : '暂无数据（开盘后逐步更新，盘后为当日收盘结果）'}
        </div>
      ) : (
        <div
          className="scroll data-table-scroll"
          role="region"
          aria-label={kind === 'zt' ? '涨停连板池表格' : '炸板池表格'}
          tabIndex="0"
        >
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th>
                <th>涨幅</th>
                {kind === 'zt' ? <th>连板</th> : <th>炸板次数</th>}
                <th>封板资金</th>
                <th>{kind === 'zt' ? '首封' : '换手'}</th>
                <th>行业</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s, i) => (
                <tr key={s.code}>
                  <td><span className="rank">{i + 1}</span><StockName code={s.code} name={s.name} /></td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  {kind === 'zt' ? (
                    <td className={s.lbc >= 2 ? 'gold' : ''} style={{ fontWeight: s.lbc >= 2 ? 700 : 400 }}>
                      {s.lbc >= 2 ? `${s.lbc}板` : '首板'}
                    </td>
                  ) : (
                    <td className="gold">{s.breakTimes}</td>
                  )}
                  <td className="red">{s.fundAmount ? fmtInflow(s.fundAmount).replace('+', '') : '--'}</td>
                  <td>{kind === 'zt' ? fmtTime(s.firstTime) : (s.turnover.toFixed(1) + '%')}</td>
                  <td className="sub-name" style={{ marginLeft: 0 }}>{s.sector || '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="legend table-note">
            {kind === 'zt'
              ? '梯队越高代表市场情绪越强；封板资金大 = 封单结实，次日溢价概率高'
              : '炸板池 = 盘中触及涨停后打开，炸板率高说明资金分歧大、情绪转弱'}
          </div>
        </div>
      )}
    </section>
  )
}
