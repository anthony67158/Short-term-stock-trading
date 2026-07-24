import { useState, useMemo } from 'react'
import { fmtPct, pctClass, fmtInflow, fmtNum } from '../format'
import StockDetail from './StockDetail'
import Icon from './Icon'

export default function StockPanel({ sector, data, loading, error, sort, setSort }) {
  const list = (data && data.list) || []
  const [detail, setDetail] = useState(null) // 点击查看详情的个股
  const [colSort, setColSort] = useState(null) // { key, dir } 表头点击排序；null=用后端 sort

  // 点表头：无→降序→升序→取消(回到后端排序)
  const clickHead = (key) => {
    setColSort((c) => {
      if (!c || c.key !== key) return { key, dir: 'desc' }
      if (c.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  const rows = useMemo(() => {
    if (!colSort) return list
    const { key, dir } = colSort
    const arr = [...list].sort((a, b) => {
      const va = Number(a[key]) || 0, vb = Number(b[key]) || 0
      return dir === 'asc' ? va - vb : vb - va
    })
    return arr
  }, [list, colSort])

  // 可排序表头单元格
  const Th = ({ label, k }) => (
    <th className={'th-sort' + (colSort && colSort.key === k ? ' active' : '')} onClick={() => clickHead(k)}>
      <span className="th-inner">{label}
        <span className="th-arrow">{colSort && colSort.key === k ? (colSort.dir === 'asc' ? '↑' : '↓') : '⇅'}</span>
      </span>
    </th>
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">
          {sector ? sector.name : '个股'} <span className="sub-name">成分股 · 点表头排序 · 点行看详情</span>
        </div>
        <div className="tabs">
          <div className={'tab' + (sort === 'pct' ? ' active' : '')} onClick={() => { setSort('pct'); setColSort(null) }}>涨幅榜</div>
          <div className={'tab' + (sort === 'down' ? ' active' : '')} onClick={() => { setSort('down'); setColSort(null) }}>跌幅榜</div>
          <div className={'tab' + (sort === 'main' ? ' active' : '')} onClick={() => { setSort('main'); setColSort(null) }}>资金榜</div>
        </div>
      </div>

      {!sector ? (
        <div className="empty">← 点击左侧任一板块，查看其成分股龙头</div>
      ) : loading && !data ? (
        <div className="loading">加载中…</div>
      ) : (
        <div className="scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>名称</th>
                <Th label="现价" k="price" />
                <Th label="涨跌幅" k="pct" />
                <Th label="换手" k="turnover" />
                <Th label="量比" k="volRatio" />
                <Th label="主力净流入" k="mainInflow" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.code} onClick={() => setDetail(s)}>
                  <td>
                    <span className="rank">{i + 1}</span>
                    {s.name}
                    {s.isLimitUp && <span className="tag tag-lu">涨停</span>}
                    {s.isLimitDown && <span className="tag tag-ld">跌停</span>}
                  </td>
                  <td>{fmtNum(s.price)}</td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  <td className={s.turnover > 10 ? 'gold' : ''}>{fmtNum(s.turnover, 1)}%</td>
                  <td className={s.volRatio > 2 ? 'gold' : ''}>{fmtNum(s.volRatio, 1)}</td>
                  <td className={pctClass(s.mainInflow)}>{fmtInflow(s.mainInflow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && list.length === 0 && <div className="empty err">数据源暂时不可用，稍后自动重试…</div>}
          <div className="legend" style={{ padding: '8px 12px' }}>
            短线提示：<span className="gold">换手&gt;10%</span> / <span className="gold">量比&gt;2</span> 标黄，代表资金活跃度高 · 点表头切换正/倒序 · 点个股查看代码/主营/K线
          </div>
        </div>
      )}

      {detail && <StockDetail stock={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
