import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { usePolling } from '../hooks'
import Icon from './Icon'
import { fmtInflow } from '../format'

// 板块归类（关键词匹配，带兜底）
function categorize(name, suffix) {
  const n = name || ''
  if (/半导体|电子|光学|面板|光电|元件|印制|PCB|通信|计算机|软件|传媒|芯片|消费电子|电子化学|游戏/.test(n)) return '科技链' + suffix
  if (/有色|金属|煤炭|钢铁|化工|化学|石油|石化|采掘|建材|氟|水泥|玻璃|稀土|钨|锂/.test(n)) return '周期资源' + suffix
  if (/银行|券商|证券|保险|金融|地产|房/.test(n)) return '金融地产' + suffix
  if (/食品|饮料|白酒|医药|医疗|商贸|零售|家电|纺织|农|林|牧|渔|旅游|酒店|美容|服装|饰品/.test(n)) return '消费医药' + suffix
  if (/电力设备|新能源|汽车|机械|军工|国防|电池|光伏|风电|设备|船|重工/.test(n)) return '制造新能源' + suffix
  return '其他' + suffix
}

export default function MarketFlow({ interval }) {
  const [type, setType] = useState('industry')
  const { data, loading } = usePolling(`/api/sectors?type=${type}&sort=main`, interval, [type])
  const list = (data && data.list) || []

  const sig = useMemo(() => list.map((s) => `${s.code}:${s.mainInflow}`).join('|'), [list])

  const { totalIn, totalOut, net, hasRealOut, option } = useMemo(() => {
    const sorted = [...list].sort((a, b) => b.mainInflow - a.mainInflow)
    const realOut = sorted.filter((s) => s.mainInflow < 0)
    const hasRealOut = realOut.length > 0

    const shownIn = sorted.filter((s) => s.mainInflow > 0).slice(0, 12)

    const totalIn = list.filter((s) => s.mainInflow > 0).reduce((a, s) => a + s.mainInflow, 0)
    const totalOut = list.filter((s) => s.mainInflow < 0).reduce((a, s) => a + s.mainInflow, 0)
    const net = totalIn + totalOut

    const yi = (v) => +(Math.abs(v) / 1e8).toFixed(2)
    const Sin = shownIn.reduce((a, s) => a + yi(s.mainInflow), 0)

    // 节点与连线
    const nodeSet = new Map()
    const links = []
    const addNode = (name, role) => { if (!nodeSet.has(name)) nodeSet.set(name, role) }
    const POOL = '盘中资金池'
    addNode(POOL, 'pool')

    if (hasRealOut) {
      // ===== 分化行情：真实的板块间资金搬家（流出板块 → 资金池）=====
      const shownOut = realOut.slice(-10) // 仅真实净流出板块
      const Sout = shownOut.reduce((a, s) => a + yi(s.mainInflow), 0)
      for (const s of shownOut) {
        const v = yi(s.mainInflow)
        if (v <= 0) continue
        const g = categorize(s.name, '流出')
        addNode(s.name, 'out'); addNode(g, 'group-out')
        links.push({ source: s.name, target: g, value: v })
      }
      const outGroupSum = {}
      for (const l of links) {
        if (nodeSet.get(l.target) === 'group-out') outGroupSum[l.target] = (outGroupSum[l.target] || 0) + l.value
      }
      for (const g in outGroupSum) links.push({ source: g, target: POOL, value: outGroupSum[g] })
      if (Sin > Sout) { addNode('场外增量资金', 'extra'); links.push({ source: '场外增量资金', target: POOL, value: +(Sin - Sout).toFixed(2) }) }
    } else {
      // ===== 全线净流入：无板块净流出，改用「相对弱势板块」体现强弱结构 =====
      // 取净流入最少的若干板块作为"相对弱势侧"（资金相对被冷落的方向）
      const weak = sorted.filter((s) => s.mainInflow > 0).slice(-8).reverse() // 净流入最少的8个
      const Sweak = weak.reduce((a, s) => a + yi(s.mainInflow), 0)
      for (const s of weak) {
        const v = yi(s.mainInflow)
        if (v <= 0) continue
        const g = categorize(s.name, '弱势')
        addNode(s.name, 'weak'); addNode(g, 'group-weak')
        links.push({ source: s.name, target: g, value: v })
      }
      const weakGroupSum = {}
      for (const l of links) {
        if (nodeSet.get(l.target) === 'group-weak') weakGroupSum[l.target] = (weakGroupSum[l.target] || 0) + l.value
      }
      for (const g in weakGroupSum) links.push({ source: g, target: POOL, value: weakGroupSum[g] })
      // 强势承接远超弱势时，差额由场外增量资金补足，保持左右守恒
      if (Sin > Sweak) { addNode('场外增量资金', 'extra'); links.push({ source: '场外增量资金', target: POOL, value: +(Sin - Sweak).toFixed(2) }) }
    }

    // 右：资金池 → 承接分组 → 承接板块
    const inGroupSum = {}
    for (const s of shownIn) {
      const g = categorize(s.name, '承接')
      inGroupSum[g] = (inGroupSum[g] || 0) + yi(s.mainInflow)
    }
    for (const g in inGroupSum) { addNode(g, 'group-in'); links.push({ source: POOL, target: g, value: inGroupSum[g] }) }
    for (const s of shownIn) {
      const v = yi(s.mainInflow)
      if (v <= 0) continue
      const g = categorize(s.name, '承接')
      addNode(s.name, 'in')
      links.push({ source: g, target: s.name, value: v })
    }

    const colorByRole = {
      out: '#f4614e', 'group-out': '#f4614e', pool: '#e3b341',
      'group-in': '#2eb872', in: '#2eb872', extra: '#5b8def',
      weak: '#c98b3a', 'group-weak': '#c98b3a', // 相对弱势：暗金/橙，区别于真流出的红
    }
    const nodes = [...nodeSet.entries()].map(([name, role]) => ({
      name,
      itemStyle: { color: colorByRole[role] || '#767881', borderColor: 'transparent' },
      label: { color: '#c9cbd3', fontSize: 11 },
    }))

    const option = {
      animation: false,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item', triggerOn: 'mousemove',
        backgroundColor: '#16181f', borderColor: '#23252d',
        textStyle: { color: '#e6e7ea', fontSize: 12 },
        formatter: (p) => {
          if (p.dataType === 'edge') return `${p.data.source} → ${p.data.target}<br/>主力净额: ${p.data.value} 亿`
          return `<b>${p.name}</b>`
        },
      },
      series: [
        {
          type: 'sankey',
          left: 8, right: 130, top: 12, bottom: 12,
          nodeWidth: 14, nodeGap: 9,
          draggable: false,
          emphasis: { focus: 'adjacency' },
          label: { color: '#c9cbd3', fontSize: 11, fontWeight: 500 },
          lineStyle: { color: 'gradient', opacity: 0.28, curveness: 0.5 },
          data: nodes,
          links,
        },
      ],
    }
    return { totalIn, totalOut, net, hasRealOut, option }
  }, [sig])

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-head">
        <div className="panel-title"><Icon name="wave" size={16} /> 大盘主力资金流向 · 桑基图 <span className="sub-name">左侧流出 → 资金池 → 右侧承接</span></div>
        <div className="tabs">
          <div className={'tab' + (type === 'industry' ? ' active' : '')} onClick={() => setType('industry')}>行业</div>
          <div className={'tab' + (type === 'concept' ? ' active' : '')} onClick={() => setType('concept')}>概念</div>
        </div>
      </div>

      <div className="flow-summary">
        <div className="flow-sum-item">
          <div className="label">流入板块承接</div>
          <div className="val red">{fmtInflow(totalIn)}</div>
        </div>
        <div className="flow-sum-item">
          <div className="label">{hasRealOut ? '流出板块抛压' : '净流出板块'}</div>
          <div className={'val ' + (hasRealOut ? 'green' : '')}>
            {hasRealOut ? fmtInflow(totalOut) : '全线净流入 · 无'}
          </div>
        </div>
        <div className="flow-sum-item">
          <div className="label">全市场主力净额</div>
          <div className={'val ' + (net >= 0 ? 'red' : 'green')}>{fmtInflow(net)}</div>
        </div>
        <div className="flow-sum-item">
          <div className="label">攻守判断</div>
          <div className="val" style={{ fontSize: 14 }}>
            {net > 50e8 ? '主力做多' : net < -50e8 ? '主力撤离' : '多空胶着'}
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="loading">加载中…</div>
      ) : (
        <div style={{ padding: '6px 8px 12px' }}>
          <ReactECharts option={option} style={{ height: 560 }} notMerge={false} lazyUpdate />
          <div className="legend" style={{ textAlign: 'center', marginTop: 6 }}>
            {hasRealOut
              ? <><span className="red">红 = 流出板块</span> · <span className="gold">金 = 盘中资金池</span> · <span className="green">绿 = 承接板块</span> · 线宽 = 主力净额，追踪资金搬家路径</>
              : <>今日全市场<span className="red">主力全线净流入</span>：左侧为<span style={{ color: '#c98b3a' }}>相对弱势板块</span>(净流入最少)+ <span style={{ color: 'var(--accent2)' }}>场外增量资金</span>，右侧为<span className="green">强势承接板块</span>，线宽 = 净流入额，体现板块强弱结构</>
            }
          </div>
        </div>
      )}
    </div>
  )
}
