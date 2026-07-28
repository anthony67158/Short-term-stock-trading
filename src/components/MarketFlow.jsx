import { useMemo, useState } from 'react'
import { usePolling } from '../hooks'
import Icon from './Icon'
import { openStockDetail } from '../detailStore'

// ============ 大盘主力资金流向（纯 CSS 流向图，稳定不依赖图表库）============
// 左列=净流出板块（绿，资金撤离）｜ 中枢=主力资金 ｜ 右列=净流入板块（红，资金进场）
// 用连接条 + 条宽表达资金大小，一眼看清"钱从哪撤、往哪进"。
export default function MarketFlow({ interval }) {
  const [type, setType] = useState('industry')
  const { data, loading } = usePolling(`/api/sectors?type=${type}&sort=main`, interval, [type])
  const list = (data && data.list) || []

  const { inTop, outTop, totalIn, totalOut, net, maxAmt } = useMemo(() => {
    const sorted = [...list].sort((a, b) => b.mainInflow - a.mainInflow)
    const inTop = sorted.filter((s) => s.mainInflow > 0).slice(0, 8)
    const outTop = sorted.filter((s) => s.mainInflow < 0).slice(-8).reverse()
    const totalIn = list.filter((s) => s.mainInflow > 0).reduce((a, s) => a + s.mainInflow, 0)
    const totalOut = list.filter((s) => s.mainInflow < 0).reduce((a, s) => a + s.mainInflow, 0)
    const net = totalIn + totalOut
    const maxAmt = Math.max(1, ...inTop.map((s) => s.mainInflow), ...outTop.map((s) => Math.abs(s.mainInflow)))
    return { inTop, outTop, totalIn, totalOut, net, maxAmt }
  }, [list])

  const yi = (v) => (v / 1e8).toFixed(2)
  const hasData = inTop.length > 0 || outTop.length > 0

  // 单侧行：name + 金额 + 占比条（side: 'out' 绿左对齐 | 'in' 红）
  const Row = (s, side) => {
    const amt = Math.abs(s.mainInflow)
    const w = Math.max(6, (amt / maxAmt) * 100)
    const cls = side === 'out' ? 'green' : 'red'
    return (
      <div className={'mf-row mf-' + side} key={s.code} onClick={() => openStockDetail && s.leadCode ? openStockDetail(s.leadCode, s.leadName) : null}>
        <div className="mf-row-head">
          <span className="mf-row-name">{s.name}</span>
          <span className={'mf-row-amt ' + cls}>{s.mainInflow >= 0 ? '+' : ''}{yi(s.mainInflow)}亿</span>
        </div>
        <div className="mf-row-bar"><span className={'mf-row-fill ' + cls} style={{ width: w + '%' }} /></div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="wave" size={16} /> 大盘主力资金流向
          <span className="sub-name">左=流出板块 · 右=流入板块 · 条越长资金越大</span>
        </div>
        <div className="tabs">
          <div className={'tab' + (type === 'industry' ? ' active' : '')} onClick={() => setType('industry')}>行业</div>
          <div className={'tab' + (type === 'concept' ? ' active' : '')} onClick={() => setType('concept')}>概念</div>
        </div>
      </div>

      {/* 汇总条 */}
      <div className="mf-summary">
        <div className="mf-sum-cell"><span className="mf-sum-k">净流入合计</span><span className="mf-sum-v red">+{(totalIn / 1e8).toFixed(1)}亿</span></div>
        <div className="mf-sum-cell"><span className="mf-sum-k">净流出合计</span><span className="mf-sum-v green">{(totalOut / 1e8).toFixed(1)}亿</span></div>
        <div className="mf-sum-cell"><span className="mf-sum-k">全市场净额</span><span className={'mf-sum-v ' + (net >= 0 ? 'red' : 'green')}>{net >= 0 ? '+' : ''}{(net / 1e8).toFixed(1)}亿</span></div>
      </div>

      {loading && !data ? (
        <div className="loading">加载资金流向中…</div>
      ) : !hasData ? (
        <div className="empty">暂无资金流向数据（休市或数据源繁忙时可能为空）</div>
      ) : (
        <div className="mf-flow">
          {/* 左：流出 */}
          <div className="mf-col mf-col-out">
            <div className="mf-col-head green"><Icon name="arrowDown" size={13} /> 资金流出 TOP</div>
            {outTop.length ? outTop.map((s) => Row(s, 'out')) : <div className="mf-col-empty">无明显流出</div>}
          </div>
          {/* 中枢 */}
          <div className="mf-hub">
            <div className="mf-hub-node"><Icon name="coins" size={18} /><span>主力资金</span></div>
            <div className={'mf-hub-net ' + (net >= 0 ? 'red' : 'green')}>{net >= 0 ? '净流入' : '净流出'} {Math.abs(net / 1e8).toFixed(1)}亿</div>
          </div>
          {/* 右：流入 */}
          <div className="mf-col mf-col-in">
            <div className="mf-col-head red"><Icon name="arrowUp" size={13} /> 资金流入 TOP</div>
            {inTop.length ? inTop.map((s) => Row(s, 'in')) : <div className="mf-col-empty">无明显流入</div>}
          </div>
        </div>
      )}
      {hasData && (
        <div className="legend" style={{ textAlign: 'center', padding: '4px 0 12px' }}>
          <span className="green">绿=主力流出的板块</span> · <span className="red">红=主力流入的板块</span> · 数据为当日主力净额(亿元)
        </div>
      )}
    </div>
  )
}
