import { useMemo, useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { usePolling } from '../hooks'
import { openStockDetail } from '../detailStore'
import { useTheme } from '../themeStore'
import Icon from './Icon'

// ============ 板块资金流向 · 桑基图（静态，打开即当时市场快照）============
// 结构：资金流出板块(绿) → 市场中枢 → 资金流入方向(红)。
// 流带宽度 = 该板块主力净额绝对值(亿)。A股无板块间真实资金路由，统一经"市场中枢"中转，
// 只表达"体量"，不编造"某板块的钱流进了另一板块"。无动画，打开时抓一次即冻结当时行情。

// ---- 北京时间 & 交易时段（仅用于标题的日期/时段文案）----
function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
function isWeekday(d) { const g = d.getDay(); return g !== 0 && g !== 6 }
const T_OPEN = 9 * 60 + 30, T_LBRK = 11 * 60 + 30, T_AOPEN = 13 * 60, T_CLOSE = 15 * 60
function sessionLabel() {
  const d = nowBJ(); const hm = d.getHours() * 60 + d.getMinutes()
  if (!isWeekday(d)) return '最近交易日收盘快照'
  if (hm < T_OPEN) return '盘前 · 昨日收盘快照'
  if (hm <= T_LBRK) return '早盘交易中 · 打开时快照'
  if (hm < T_AOPEN) return '午间休市 · 上午收盘快照'
  if (hm <= T_CLOSE) return '午盘交易中 · 打开时快照'
  return '已收盘 · 全天收盘快照'
}
function nowClock() { const d = nowBJ(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

export default function FundFlowCanvas({
  interval,
  snapshot = null,
  snapshotLoading = false,
}) {
  const theme = useTheme()
  const light = theme === 'light'

  // 实时快照数据源（打开时抓一次；下方 frozen 逻辑保证后续轮询不再改变画面）
  const fallback = usePolling(
    !snapshotLoading && !snapshot
      ? '/api/sectors?type=industry&sort=main'
      : null,
    interval,
    [],
  )
  const data = snapshot || fallback.data
  const loading = snapshotLoading || fallback.loading
  const liveList = (data && data.list) || []

  // 冻结：把首个非空快照锁定为"打开时的市场情况"，之后即使轮询到新数据也不覆盖。
  const [frozen, setFrozen] = useState(null)
  useEffect(() => {
    if (!frozen && liveList.length > 0) setFrozen({ list: liveList, at: nowClock() })
    // eslint-disable-next-line
  }, [liveList.length])
  const list = frozen ? frozen.list : liveList

  // 取两侧 TOP：右=主力净额最强(资金进场)，左=最弱(资金撤离)。
  const { outTop, inTop, totalIn, totalOut, net } = useMemo(() => {
    const sorted = [...list].sort((a, b) => b.mainInflow - a.mainInflow)
    const N = Math.min(8, Math.floor(sorted.length / 2) || sorted.length)
    const inTop = sorted.slice(0, N)
    const outTop = sorted.slice(-N).reverse()
    const totalIn = list.filter((s) => s.mainInflow > 0).reduce((a, s) => a + s.mainInflow, 0)
    const totalOut = list.filter((s) => s.mainInflow < 0).reduce((a, s) => a + s.mainInflow, 0)
    return { outTop, inTop, totalIn, totalOut, net: totalIn + totalOut }
  }, [list])
  const hasData = outTop.length > 0 && inTop.length > 0

  // 主题相关色板
  const C = useMemo(() => light
    ? { green: '#168a40', red: '#cf352d', hub: '#1f5f9f', label: '#1c2d4b',
        tipBg: 'rgba(248,250,253,.98)', tipBorder: 'rgba(31,95,159,.32)', tipText: '#071126', linkOp: 0.46 }
    : { green: '#3fb950', red: '#f4614e', hub: '#5f9fe3', label: '#c1c5cd',
        tipBg: 'rgba(7,17,38,.96)', tipBorder: 'rgba(117,183,255,.38)', tipText: '#f8fafd', linkOp: 0.42 },
  [light])

  const HUB = '市场中枢'
  const yi = (v) => (Math.abs(v) / 1e8).toFixed(2)

  // ---------- 桑基图 option ----------
  const sankeyOption = useMemo(() => {
    if (!hasData) return null
    // 节点带金额的完整标签；左列标签靠左、右列靠右、外扩确保文字完整不被裁切
    const nodes = [
      ...outTop.map((s) => ({
        name: s.name, depth: 0, itemStyle: { color: C.green },
        label: {
          position: 'left',
          formatter: `${s.name}  ${yi(s.mainInflow)}亿`,
          color: C.green,
          width: 126,
          overflow: 'truncate',
        },
      })),
      { name: HUB, depth: 1, itemStyle: { color: C.hub },
        label: { position: 'inside', formatter: HUB, color: light ? '#fff' : '#fff', fontWeight: 700 } },
      ...inTop.map((s) => ({
        name: s.name, depth: 2, itemStyle: { color: C.red },
        label: {
          position: 'right',
          formatter: `${yi(s.mainInflow)}亿  ${s.name}`,
          color: C.red,
          width: 126,
          overflow: 'truncate',
        },
      })),
    ]
    const links = [
      ...outTop.map((s) => ({ source: s.name, target: HUB, value: Math.abs(s.mainInflow) / 1e8, lineStyle: { color: 'source', opacity: C.linkOp } })),
      ...inTop.map((s) => ({ source: HUB, target: s.name, value: Math.abs(s.mainInflow) / 1e8, lineStyle: { color: 'target', opacity: C.linkOp } })),
    ]
    return {
      backgroundColor: 'transparent',
      animation: false,
      tooltip: {
        trigger: 'item', backgroundColor: C.tipBg, borderColor: C.tipBorder, borderWidth: 1,
        textStyle: { color: C.tipText, fontSize: 12 }, extraCssText: 'box-shadow:0 4px 16px rgba(0,0,0,.18);',
        formatter: (p) => {
          if (p.dataType === 'edge') {
            const dir = p.data.target === HUB ? '流出' : '流入'
            const nm = p.data.target === HUB ? p.data.source : p.data.target
            return `${nm}<br/><b>${dir} ${p.data.value.toFixed(2)} 亿</b>`
          }
          return `<b>${p.name}</b>`
        },
      },
      series: [{
        type: 'sankey', left: 144, right: 144, top: 16, bottom: 16,
        nodeWidth: 16, nodeGap: 12, nodeAlign: 'justify', draggable: false,
        emphasis: { focus: 'adjacency' },
        label: { fontSize: 12.5, fontWeight: 600, overflow: 'none' },
        lineStyle: { curveness: 0.5 },
        data: nodes, links,
      }],
    }
  }, [hasData, outTop, inTop, C, light])

  const onEvents = useMemo(() => ({
    click: (p) => {
      if (p.dataType !== 'node' || p.name === HUB) return
      const hit = [...outTop, ...inTop].find((s) => s.name === p.name)
      if (hit && hit.leadCode) openStockDetail(hit.leadCode, hit.leadName)
    },
  }), [outTop, inTop])

  const today = nowBJ()
  const dateLabel = `${String(today.getMonth() + 1).padStart(2, '0')}月${String(today.getDate()).padStart(2, '0')}日`

  return (
    <div className="panel ffc-panel">
      <div className="panel-head ffc-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="wave" size={16} />
          板块资金流向
        </div>
        <div className="ffc-date-wrap">
          <div className="ffc-date">{dateLabel}</div>
          <div className="ffc-session">{sessionLabel()}{frozen ? ` · ${frozen.at}` : ''}</div>
        </div>
      </div>
      <div className="ffc-legend">
        <span className="ffc-lg"><i className="dot out" /> 资金流出（绿）</span>
        <span className="ffc-lg"><i className="dot in" /> 资金流入（红）</span>
        <span className="ffc-lg ffc-lg-note">流带宽度 = 主力净额体量</span>
      </div>

      {loading && !data ? (
        <div className="loading">加载资金流向中…</div>
      ) : !hasData ? (
        <div className="empty">暂无资金流向数据（休市或数据源繁忙时可能为空）</div>
      ) : (
        <div className="ffc-stage sankey">
          <div className="ffc-sankey-heads">
            <span className="green">资金流出板块</span>
            <span className="mid">市场中枢</span>
            <span className="red">资金流入方向</span>
          </div>
          <ReactECharts
            option={sankeyOption}
            className="market-flow-chart"
            style={{
              '--market-flow-height': `${Math.max(340, Math.max(outTop.length, inTop.length) * 40 + 36)}px`,
              height: Math.max(380, Math.max(outTop.length, inTop.length) * 46 + 48),
            }}
            notMerge lazyUpdate onEvents={onEvents}
          />
        </div>
      )}

      {hasData && (
        <div className="ffc-summary">
          <span>净流出合计 <b className="green">{(totalOut / 1e8).toFixed(1)}亿</b></span>
          <span>净流入合计 <b className="red">+{(totalIn / 1e8).toFixed(1)}亿</b></span>
          <span>全市场净额 <b className={net >= 0 ? 'red' : 'green'}>{net >= 0 ? '+' : ''}{(net / 1e8).toFixed(1)}亿</b></span>
        </div>
      )}
    </div>
  )
}
