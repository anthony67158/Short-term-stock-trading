import { useState, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import Icon from './Icon'
import StockName from './StockName'
import { fmtPct, pctClass, fmtInflow, fmtNum } from '../format'

export default function SectorPanel({ data, loading, error, type, setType, selected, onSelect }) {
  const [view, setView] = useState('list') // list | heat
  const [fullscreen, setFullscreen] = useState(false)
  const [colSort, setColSort] = useState(null) // { key, dir } 表头排序
  const list = (data && data.list) || []

  const clickHead = (key) => setColSort((c) => {
    if (!c || c.key !== key) return { key, dir: 'desc' }
    if (c.dir === 'desc') return { key, dir: 'asc' }
    return null
  })
  const sortedList = useMemo(() => {
    if (!colSort) return list
    const { key, dir } = colSort
    return [...list].sort((a, b) => {
      const va = Number(a[key]) || 0, vb = Number(b[key]) || 0
      return dir === 'asc' ? va - vb : vb - va
    })
  }, [list, colSort])
  const Th = ({ label, k }) => (
    <th className={'th-sort' + (colSort && colSort.key === k ? ' active' : '')}>
      <button type="button" className="th-inner" onClick={() => clickHead(k)}>
        {label}
        <span className="th-arrow">{colSort && colSort.key === k ? (colSort.dir === 'asc' ? '↑' : '↓') : '⇅'}</span>
      </button>
    </th>
  )

  // 只依赖真正影响图形的数据签名，避免每次渲染都重建 option 导致闪烁
  const heatSig = useMemo(
    () => list.map((s) => `${s.code}:${s.pct}:${s.amount}`).join('|'),
    [list]
  )

  const buildHeatOption = (count) => ({
    animation: false, // 关闭动画，数据刷新时不重放入场动画（消除闪烁）
    tooltip: {
      backgroundColor: '#16181f',
      borderColor: '#23252d',
      textStyle: { color: '#e6e7ea', fontSize: 12 },
      formatter: (p) =>
        `<b>${p.name}</b><br/>涨跌: ${fmtPct(p.data.pct)}<br/>主力净流入: ${fmtInflow(p.data.inflow)}`,
    },
    series: [
      {
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        animation: false,
        animationDurationUpdate: 0,
        width: '100%',
        height: '100%',
        top: 2, left: 2, right: 2, bottom: 2,
        label: {
          show: true,
          formatter: (p) => `{name|${p.name}}\n{pct|${fmtPct(p.data.pct)}}`,
          rich: {
            name: { color: '#fff', fontSize: 12, fontWeight: 600, lineHeight: 18 },
            pct: { color: 'rgba(255,255,255,.85)', fontSize: 11, lineHeight: 15 },
          },
        },
        itemStyle: { borderColor: '#08090c', borderWidth: 2, gapWidth: 2, borderRadius: 4 },
        data: list.slice(0, count).map((s) => ({
          name: s.name,
          value: Math.abs(s.amount) || 1,
          code: s.code,
          pct: s.pct,
          inflow: s.mainInflow,
          mainRatio: s.mainRatio,
          itemStyle: { color: colorByPct(s.pct) },
        })),
      },
    ],
  })

  // 用 useMemo 缓存 option：仅在数据签名变化时才生成新对象，
  // 配合 notMerge={false} + lazyUpdate，实现平滑增量更新，不闪
  const heatOption40 = useMemo(() => buildHeatOption(40), [heatSig])
  const heatOption80 = useMemo(() => buildHeatOption(80), [heatSig])

  // 点击热力图方块 → 选中该板块（右侧 StockPanel 展示成分股）
  const onHeatClick = (params) => {
    const d = params && params.data
    if (d && d.code) {
      onSelect({ code: d.code, name: d.name, pct: d.pct })
      setFullscreen(false)
    }
  }
  const heatEvents = { click: onHeatClick }

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div role="heading" aria-level="2" className="panel-title"><Icon name="chart" size={16} /> 板块资金流向</div>
          <div className="panel-head-actions">
            <div className="tabs">
              <button type="button" className={'tab' + (type === 'industry' ? ' active' : '')} aria-pressed={type === 'industry'} onClick={() => setType('industry')}>行业</button>
              <button type="button" className={'tab' + (type === 'concept' ? ' active' : '')} aria-pressed={type === 'concept'} onClick={() => setType('concept')}>概念</button>
            </div>
            <div className="tabs">
              <button type="button" className={'tab' + (view === 'list' ? ' active' : '')} aria-pressed={view === 'list'} onClick={() => setView('list')}>榜单</button>
              <button type="button" className={'tab' + (view === 'heat' ? ' active' : '')} aria-pressed={view === 'heat'} onClick={() => setView('heat')}>热力图</button>
            </div>
            {view === 'heat' && (
              <button className="btn" onClick={() => setFullscreen(true)}><Icon name="layers" size={13} /> 全屏</button>
            )}
          </div>
        </div>

        {loading && !data ? (
          <div className="loading">加载中…</div>
        ) : view === 'heat' ? (
          <div className="heatmap">
            <ReactECharts option={heatOption40} style={{ height: 520 }} notMerge={false} lazyUpdate onEvents={heatEvents} />
            <div className="legend" style={{ textAlign: 'center', marginTop: 8 }}>
              面积 = 成交额 · 颜色 = 涨跌幅（红涨绿跌）· 点击方块看成分股 · 右上「全屏」看大图
            </div>
          </div>
        ) : (
          <div className="scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>板块</th>
                  <Th label="涨跌幅" k="pct" />
                  <Th label="主力净流入" k="mainInflow" />
                  <Th label="净占比" k="mainRatio" />
                  <th>领涨股</th>
                </tr>
              </thead>
              <tbody>
                {sortedList.map((s, i) => (
                  <tr
                    key={s.code}
                    className={selected && selected.code === s.code ? 'sel' : ''}
                    onClick={() => onSelect(s)}
                  >
                    <td>
                      <span className="rank">{i + 1}</span>
                      {s.name}
                    </td>
                    <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                    <td className={pctClass(s.mainInflow)}>{fmtInflow(s.mainInflow)}</td>
                    <td className={pctClass(s.mainRatio)}>{fmtNum(s.mainRatio, 1)}%</td>
                    <td>
                      {s.leadCode
                        ? <StockName code={s.leadCode} name={s.leadName} stopPropagation />
                        : <span>--</span>}
                      {s.leadPct != null ? <span className={'sub-name ' + pctClass(s.leadPct)}>{fmtPct(s.leadPct)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {error && list.length === 0 && <div className="empty err">数据源暂时不可用，稍后自动重试…</div>}
          </div>
        )}
      </div>

      {fullscreen && (
        <div className="modal-mask heatmap-modal-mask" role="dialog" aria-modal="true" aria-label="板块资金热力图" onClick={() => setFullscreen(false)}>
          <div className="modal-bar heatmap-modal-bar" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title heatmap-modal-copy">
              <span><Icon name="chart" size={17} /> 板块资金热力图 · {type === 'industry' ? '行业' : '概念'}</span>
              <span className="sub-name">面积=成交额 · 红涨绿跌</span>
            </div>
            <button type="button" className="modal-close" aria-label="关闭板块资金热力图" onClick={() => setFullscreen(false)}><Icon name="close" size={16} /></button>
          </div>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <ReactECharts option={heatOption80} style={{ height: '100%' }} notMerge={false} lazyUpdate onEvents={heatEvents} />
          </div>
        </div>
      )}
    </>
  )
}

function colorByPct(pct) {
  const cap = Math.min(Math.abs(pct) / 5, 1)
  if (pct > 0) return `rgba(244,97,78,${0.4 + cap * 0.5})`
  if (pct < 0) return `rgba(63,185,80,${0.4 + cap * 0.5})`
  return '#2a2d36'
}
