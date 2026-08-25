import { useState, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import { fmtPct, pctClass, fmtInflow, fmtNum , fmtRaw } from '../format'
import StockDetail from './StockDetail'
import Icon from './Icon'
import StockName from './StockName'
import { useStockTags } from '../stockTagStore'

function colorByPct(pct) {
  const cap = Math.min(Math.abs(pct) / 5, 1)
  if (pct > 0) return `rgba(244,97,78,${0.4 + cap * 0.5})`
  if (pct < 0) return `rgba(63,185,80,${0.4 + cap * 0.5})`
  return '#2a2d36'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export default function StockPanel({ sector, data, loading, error, sort, setSort }) {
  const list = (data && data.list) || []
  const [detail, setDetail] = useState(null) // 点击查看详情的个股
  const [colSort, setColSort] = useState(null) // { key, dir } 表头点击排序；null=用后端 sort
  const [view, setView] = useState('list') // list | heat 榜单/热力图
  const [fullscreen, setFullscreen] = useState(false)
  const stockTags = useStockTags(list.map((item) => item.code))

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
    <th
      className={'th-sort' + (colSort && colSort.key === k ? ' active' : '')}
      aria-sort={colSort?.key === k ? (colSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="th-inner" onClick={() => clickHead(k)}>
        {label}
        <span className="th-arrow">{colSort && colSort.key === k ? (colSort.dir === 'asc' ? '↑' : '↓') : '⇅'}</span>
      </button>
    </th>
  )

  // ---- 热力图：面积=成交额，颜色=涨跌幅（红涨绿跌）----
  const heatSig = useMemo(
    () => list.map((s) => `${s.code}:${s.pct}:${s.amount}`).join('|'),
    [list]
  )
  const tagSig = list.map((item) => {
    const tags = stockTags[item.code]?.displayTags || []
    return `${item.code}:${tags.map((tag) => tag.name).join('/')}`
  }).join('|')
  const buildHeatOption = (count) => ({
    animation: false,
    tooltip: {
      backgroundColor: '#16181f', borderColor: '#23252d',
      textStyle: { color: '#e6e7ea', fontSize: 12 },
      formatter: (p) =>
        `<b>${escapeHtml(p.name)}</b> <span style="color:#8a8d96">${escapeHtml(p.data.code)}</span><br/>`
        + (p.data.tagText ? `题材/行业: ${escapeHtml(p.data.tagText)}<br/>` : '')
        + `现价: ${fmtRaw(p.data.price)}<br/>涨跌: ${fmtPct(p.data.pct)}<br/>`
        + `换手: ${fmtNum(p.data.turnover, 1)}% · 量比: ${fmtNum(p.data.volRatio, 1)}<br/>`
        + `主力净流入: ${fmtInflow(p.data.inflow)}`,
    },
    series: [{
      type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false },
      animation: false, animationDurationUpdate: 0,
      width: '100%', height: '100%', top: 2, left: 2, right: 2, bottom: 2,
      label: {
        show: true,
        formatter: (p) => `{name|${p.name}}\n${p.data.tagText ? `{tag|${p.data.tagText}}\n` : ''}{pct|${fmtPct(p.data.pct)}}`,
        rich: {
          name: { color: '#fff', fontSize: 12, fontWeight: 600, lineHeight: 18 },
          tag: { color: 'rgba(255,255,255,.72)', fontSize: 9, lineHeight: 12 },
          pct: { color: 'rgba(255,255,255,.85)', fontSize: 11, lineHeight: 15 },
        },
      },
      itemStyle: { borderColor: '#08090c', borderWidth: 2, gapWidth: 2, borderRadius: 4 },
      data: list.slice(0, count).map((s) => {
        const tags = stockTags[s.code]?.displayTags || []
        return {
          name: s.name, value: Math.abs(s.amount) || Math.abs(s.mainInflow) || 1,
          code: s.code, price: s.price, pct: s.pct, turnover: s.turnover, volRatio: s.volRatio,
          inflow: s.mainInflow,
          tagText: tags.map((tag) => tag.name).join(' · '),
          itemStyle: { color: colorByPct(s.pct) },
        }
      }),
    }],
  })
  const heatOption = useMemo(() => buildHeatOption(60), [heatSig, tagSig])
  const heatOptionFull = useMemo(() => buildHeatOption(120), [heatSig, tagSig])
  const heatEvents = { click: (params) => { const d = params && params.data; if (d && d.code) { setDetail({ code: d.code, name: d.name, price: d.price, pct: d.pct }); setFullscreen(false) } } }
  const openDetail = (stock) => setDetail(stock)
  const handleRowKeyDown = (event, stock) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openDetail(stock)
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="layers" size={16} />
          {sector ? sector.name : '个股'} <span className="sub-name">成分股 · {view === 'heat' ? '面积=成交额 · 红涨绿跌 · 点方块看详情' : '点表头排序 · 点行看详情'}</span>
        </div>
        <div className="panel-head-actions">
          <div className="tabs">
            <button type="button" className={'tab' + (sort === 'pct' ? ' active' : '')} aria-pressed={sort === 'pct'} onClick={() => { setSort('pct'); setColSort(null) }}>涨幅榜</button>
            <button type="button" className={'tab' + (sort === 'down' ? ' active' : '')} aria-pressed={sort === 'down'} onClick={() => { setSort('down'); setColSort(null) }}>跌幅榜</button>
            <button type="button" className={'tab' + (sort === 'main' ? ' active' : '')} aria-pressed={sort === 'main'} onClick={() => { setSort('main'); setColSort(null) }}>资金榜</button>
          </div>
          <div className="tabs">
            <button type="button" className={'tab' + (view === 'list' ? ' active' : '')} aria-pressed={view === 'list'} onClick={() => setView('list')}>榜单</button>
            <button type="button" className={'tab' + (view === 'heat' ? ' active' : '')} aria-pressed={view === 'heat'} onClick={() => setView('heat')}>热力图</button>
          </div>
          {sector && view === 'heat' && (
            <button className="btn" onClick={() => setFullscreen(true)}><Icon name="layers" size={13} /> 全屏</button>
          )}
        </div>
      </div>

      {!sector ? (
        <div className="empty">← 点击左侧任一板块，查看其成分股龙头</div>
      ) : loading && !data ? (
        <div className="loading">加载中…</div>
      ) : view === 'heat' ? (
        <div className="heatmap">
          {list.length === 0 ? (
            <div className="empty">暂无成分股数据{error ? '，数据源暂时不可用，稍后自动重试…' : ''}</div>
          ) : (
            <>
              <ReactECharts option={heatOption} className="market-treemap-chart" style={{ height: 480 }} notMerge={false} lazyUpdate onEvents={heatEvents} />
              <div className="legend chart-note">
                面积 = 成交额（占比越大方块越大）· 颜色 = 涨跌幅（红涨绿跌，越深幅度越大）· 点方块看K线 · 右上「全屏」看全部
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          className="scroll data-table-scroll data-table-scroll-lg"
          role="region"
          aria-label={`${sector.name}成分股表格`}
          tabIndex="0"
        >
          <table className="tbl stock-panel-table">
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
                <tr
                  key={s.code}
                  onClick={() => openDetail(s)}
                  onKeyDown={(event) => handleRowKeyDown(event, s)}
                  tabIndex="0"
                  aria-label={`查看${s.name}详情`}
                >
                  <td className="stock-panel-identity">
                    <span className="stock-panel-identity-inner">
                      <span className="rank">{i + 1}</span>
                      <StockName code={s.code} name={s.name} stopPropagation />
                      {s.isLimitUp && <span className="tag tag-lu">涨停</span>}
                      {s.isLimitDown && <span className="tag tag-ld">跌停</span>}
                    </span>
                  </td>
                  <td>{fmtRaw(s.price)}</td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  <td className={s.turnover > 10 ? 'gold' : ''}>{fmtNum(s.turnover, 1)}%</td>
                  <td className={s.volRatio > 2 ? 'gold' : ''}>{fmtNum(s.volRatio, 1)}</td>
                  <td className={pctClass(s.mainInflow)}>{fmtInflow(s.mainInflow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && list.length === 0 && <div className="empty err">数据源暂时不可用，稍后自动重试…</div>}
          <div className="legend table-note">
            短线提示：<span className="gold">换手&gt;10%</span> / <span className="gold">量比&gt;2</span> 标黄，代表资金活跃度高 · 点表头切换正/倒序 · 点个股查看代码/主营/K线
          </div>
        </div>
      )}

      {fullscreen && (
        <div className="modal-mask heatmap-modal-mask" role="dialog" aria-modal="true" aria-label="成分股热力图" onClick={() => setFullscreen(false)}>
          <div className="modal-bar heatmap-modal-bar" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title heatmap-modal-copy">
              <span><Icon name="chart" size={17} /> {sector ? sector.name : ''} 成分股热力图</span>
              <span className="sub-name">面积=成交额 · 红涨绿跌 · 点方块看K线</span>
            </div>
            <button type="button" className="modal-close" aria-label="关闭成分股热力图" onClick={() => setFullscreen(false)}><Icon name="close" size={16} /></button>
          </div>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <ReactECharts option={heatOptionFull} style={{ height: '100%' }} notMerge={false} lazyUpdate onEvents={heatEvents} />
          </div>
        </div>
      )}

      {detail && <StockDetail stock={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
