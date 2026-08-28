import { useState, useMemo } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import LimitPool from './LimitPool'
import { usePolling } from '../hooks'
import { planStore, usePlanStore } from '../planStore'
import DailyReport from './DailyReport'
import SectorForecast from './SectorForecast'
import ErrorBoundary from './ErrorBoundary'
import { fmtPct, pctClass, fmtInflow, fmtRaw } from '../format'
import { deriveMarketRegime } from '../../shared/marketRegime.js'
import {
  buildMarketBoardGuidance,
  buildSentimentGuidance,
} from '../../shared/marketGuidance.js'

// ============ 今日决策：先定方向，再核验个股 ============
export default function TodayTab({ interval, market, sectors }) {
  const zt = usePolling('/api/board?type=limitup&kind=zt', interval)
  const zb = usePolling('/api/board?type=limitup&kind=zb', interval)
  const movers = usePolling('/api/board?type=movers&kind=inflow', interval)
  const speed = usePolling('/api/board?type=movers&kind=speed', interval)

  return (
    <div className="today">
      <MarketLight
        market={market}
        sectors={sectors}
        limitUp={zt.data}
      />
      <SentimentGauge zt={zt.data} zb={zb.data} market={market} />
      <ErrorBoundary label="板块前瞻">
        <SectorForecast />
      </ErrorBoundary>
      <CandidatePool
        zt={zt.data}
        movers={movers.data}
        speed={speed.data}
      />
      <LimitPool interval={interval} />
    </div>
  )
}

function MarketInterpretation({ guidance, compact = false }) {
  return (
    <div
      className={
        'market-interpretation'
        + (compact ? ' compact' : '')
      }
      data-tone={guidance.tone}
      role="note"
      aria-label="盘面数据解读"
    >
      <span className="market-interpretation-icon">
        <Icon name={guidance.icon} size={15} />
      </span>
      <div className="market-interpretation-body">
        <div className="market-interpretation-title">
          <span>这些数据说明</span>
          <strong>{guidance.conclusion}</strong>
        </div>
        <p>{guidance.evidence}</p>
        <div className="market-interpretation-action">
          <span>操作参考</span>
          <b>{guidance.action}</b>
        </div>
      </div>
    </div>
  )
}

// ---------- 市场情绪温度计（用涨停/炸板池本地计算，不占接口）----------
function SentimentGauge({ zt, zb, market }) {
  const g = useMemo(() => {
    const ztList = (zt && zt.list) || []
    const zbList = (zb && zb.list) || []
    const ztCount = Number.isFinite(Number(zt?.total)) ? Number(zt.total) : ztList.length
    const zbCount = Number.isFinite(Number(zb?.total)) ? Number(zb.total) : zbList.length
    // 炸板率 = 炸板数 /(涨停数+炸板数)
    const breakRate = (ztCount + zbCount) ? Math.round(zbCount / (ztCount + zbCount) * 100) : null
    // 连板梯队：按 lbc(连板数) 分布
    const tiers = {}
    let maxBoard = 0
    ztList.forEach((s) => {
      const lb = s.lbc || 1
      if (lb > maxBoard) maxBoard = lb
      const key = lb >= 2 ? lb : 1
      tiers[key] = (tiers[key] || 0) + 1
    })
    const lianban = ztList.length - (tiers[1] || 0) // 连板数(>=2板)
    const b = (market && market.breadth) || {}
    // 情绪温度分：涨停多、炸板率低、连板高 → 高分
    let score = 50
    if (ztCount >= 60) score += 15; else if (ztCount >= 30) score += 8; else if (ztCount < 15) score -= 12
    if (breakRate != null) { if (breakRate <= 15) score += 12; else if (breakRate >= 35) score -= 15 }
    if (maxBoard >= 5) score += 10; else if (maxBoard >= 3) score += 5
    if (b.limitDown > 10) score -= 10
    score = Math.max(0, Math.min(100, score))
    const level = score >= 70 ? { t: '情绪火热', c: 'red' } : score >= 55 ? { t: '情绪偏暖', c: 'gold' } : score >= 40 ? { t: '情绪中性', c: 'muted' } : { t: '情绪偏冷', c: 'green' }
    return { ztCount, zbCount, breakRate, maxBoard, lianban, score, level, b }
  }, [zt, zb, market])
  const guidance = buildSentimentGuidance(g)

  if (!zt) return null
  return (
    <section className="panel senti-gauge workbench-aside">
      <div className="sg-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="fire" size={16} /> 市场情绪温度计</div>
        <span className={'sg-level ' + g.level.c}>{g.level.t} · {g.score}分</span>
      </div>
      <div className="sg-bar"><span className={'sg-bar-fill ' + g.level.c} style={{ width: g.score + '%' }} /></div>
      <div className="sg-cells">
        <div className="sg-cell"><span className="sg-k">涨停</span><span className="sg-v red">{g.ztCount}</span></div>
        <div className="sg-cell"><span className="sg-k">炸板</span><span className="sg-v">{g.zbCount}</span></div>
        <div className="sg-cell"><span className="sg-k">炸板率</span><span className={'sg-v ' + (g.breakRate != null && g.breakRate >= 35 ? 'green' : g.breakRate != null && g.breakRate <= 15 ? 'red' : '')}>{g.breakRate != null ? g.breakRate + '%' : '--'}</span></div>
        <div className="sg-cell"><span className="sg-k">最高板</span><span className="sg-v gold">{g.maxBoard || '--'}板</span></div>
        <div className="sg-cell"><span className="sg-k">连板数</span><span className="sg-v">{g.lianban}</span></div>
        <div className="sg-cell"><span className="sg-k">跌停</span><span className="sg-v green">{g.b.limitDown ?? '--'}</span></div>
      </div>
      <MarketInterpretation guidance={guidance} compact />
    </section>
  )
}

// ---------- 大盘盘面（指数全景 + 情绪红绿灯 + 今日操作建议）----------
function MarketLight({ market, sectors, limitUp }) {
  const b = (market && market.breadth) || {}
  const idx = (market && market.indices) || []
  const ratio = b.down ? b.up / b.down : (b.up ? 9 : 1)
  const zt = Number.isFinite(Number(limitUp?.total))
    ? Number(limitUp.total)
    : b.limitUp
  const dt = b.limitDown
  const regime = deriveMarketRegime({
    ...(market || {}),
    breadth: {
      ...b,
      limitUp: zt,
      limitDown: dt,
    },
  })
  const regimeView = {
    TREND_STRONG: {
      light: 'green',
      status: '可以做',
      text: '趋势偏强，可在风险预算内顺势参与',
      icon: 'target',
      title: '今日按强势趋势执行',
      sub: `优先主线强势股，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    RANGE: {
      light: 'yellow',
      status: '震荡应对',
      text: '震荡均衡，低吸高抛但不追涨',
      icon: 'gauge',
      title: '今日以持仓管理为主',
      sub: `优先做T与回踩确认，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    TRANSITION: {
      light: 'yellow',
      status: '等待确认',
      text: '方向切换，降低试错频率',
      icon: 'gauge',
      title: '今日轻仓等待共振',
      sub: `只处理确定性较高的机会，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    RISK_OFF: {
      light: 'red',
      status: '控制风险',
      text: '风险偏高，暂停普通新增仓位',
      icon: 'shield',
      title: '今日优先降低风险',
      sub: `先处理弱势持仓，目标总仓位 ${regime.targetPositionPct.min}~${regime.targetPositionPct.max}%`,
    },
    UNKNOWN: {
      light: 'red',
      status: '数据不足',
      text: '关键市场证据不足',
      icon: 'shield',
      title: '今日暂停新增风险',
      sub: '等待指数与市场广度恢复后再评估',
    },
  }[regime.regime]
  const { light } = regimeView
  const topSector = (sectors && sectors.list && sectors.list[0]) || null
  const guidance = buildMarketBoardGuidance({
    regime,
    indices: idx,
    breadth: b,
    topSector,
    limitUp: zt,
    limitDown: dt,
  })

  const [reportOpen, setReportOpen] = useState(false) // 策略日报抽屉

  return (
    <section className="panel market-board workbench-primary">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="pulse" size={16} /> 大盘盘面 <span className="sub-name">开盘先看势，定今日仓位</span></div>
        <div className="market-actions">
          <button className="btn btn-primary" onClick={() => setReportOpen(true)}>
            <Icon name="clipboard" size={13} />
            策略日报
          </button>
          <div className={'mb-light ' + light}>
            <span className="orb-dot" />
            {regimeView.status} · {regimeView.text}
          </div>
        </div>
      </div>
      {reportOpen && <DailyReport onClose={() => setReportOpen(false)} />}

      {/* 今日操作建议：盘面纪律由实时涨跌家数与涨跌停结构确定。 */}
      {(() => {
        const plan = {
          icon: regimeView.icon,
          title: regimeView.title,
          sub: regimeView.sub,
          tone: regimeView.light,
        }
        return (
          <div className={'mb-plan ' + plan.tone}>
            <span className="mb-plan-icon"><Icon name={plan.icon} size={18} /></span>
            <div className="mb-plan-txt">
              <div className="mb-plan-title">{plan.title}</div>
              <div className="mb-plan-sub">{plan.sub}</div>
            </div>
          </div>
        )
      })()}

      <div className="mb-body">
        {/* 指数全景：上证/深证/创业板/北证 */}
        <div className="mb-indices">
          {idx.map((i) => (
            <div className="mb-idx" key={i.code}>
              <div className="mb-idx-name">{i.name}</div>
              <div className={'mb-idx-price ' + pctClass(i.pct)}>{i.price ? fmtRaw(i.price) : '--'}</div>
              <div className={'mb-idx-pct ' + pctClass(i.pct)}>{fmtPct(i.pct)}</div>
            </div>
          ))}
        </div>
        {/* 情绪指标 */}
        <div className="mb-stats">
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌停</div>
            <div className="mb-stat-val"><span className="red">{zt ?? '--'}</span><span className="sep">/</span><span className="green">{dt ?? '--'}</span></div>
          </div>
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌家数</div>
            <div className="mb-stat-val"><span className="red">{b.up || 0}</span><span className="sep">/</span><span className="green">{b.down || 0}</span></div>
          </div>
          <div className="mb-stat">
            <div className="mb-stat-label">涨跌比</div>
            <div className={'mb-stat-val ' + (ratio >= 1 ? 'red' : 'green')}>{ratio.toFixed(2)}</div>
          </div>
          {topSector && (
            <div className="mb-stat">
              <div className="mb-stat-label">最强板块</div>
              <div className="mb-stat-val gold" style={{ fontSize: 14 }}>{topSector.name}</div>
            </div>
          )}
        </div>
      </div>
      <MarketInterpretation guidance={guidance} />
    </section>
  )
}

// ---------- 精选候选池（涨停/异动/涨速/资金 合成带标签列表） ----------
function CandidatePool({ zt, movers, speed }) {
  const [tab, setTab] = useState('hot') // hot(综合) | limit | inflow | speed
  const [colSort, setColSort] = useState(null) // { key, dir } 表头点击排序；null=用默认榜单排序
  const book = usePlanStore()

  const clickHead = (key) => setColSort((c) => {
    if (!c || c.key !== key) return { key, dir: 'desc' }
    if (c.dir === 'desc') return { key, dir: 'asc' }
    return null
  })
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

  const rows = useMemo(() => {
    const map = new Map()
    const push = (s, tag) => {
      if (!s.code) return
      if (!map.has(s.code)) map.set(s.code, { code: s.code, name: s.name, price: s.price, pct: s.pct, tags: [], mainInflow: s.mainInflow || 0, lbc: s.lbc, speed: s.speed })
      const o = map.get(s.code)
      if (!o.tags.includes(tag)) o.tags.push(tag)
      if (s.price) o.price = s.price
      if (s.mainInflow) o.mainInflow = s.mainInflow
      if (s.lbc) o.lbc = s.lbc
      if (s.speed !== undefined) o.speed = s.speed
    }
    ;(zt?.list || []).slice(0, 20).forEach((s) => push({ ...s, mainInflow: s.fundAmount }, s.lbc >= 2 ? `${s.lbc}连板` : '涨停'))
    ;(movers?.list || []).slice(0, 20).forEach((s) => push(s, '主力抢筹'))
    ;(speed?.list || []).slice(0, 15).forEach((s) => push(s, '涨速'))

    let arr = [...map.values()]
    if (tab === 'limit') arr = arr.filter((x) => x.tags.some((t) => t.includes('板') || t === '涨停'))
    else if (tab === 'inflow') arr = arr.filter((x) => x.tags.includes('主力抢筹')).sort((a, b) => b.mainInflow - a.mainInflow)
    else if (tab === 'speed') arr = arr.filter((x) => x.tags.includes('涨速')).sort((a, b) => (b.speed || 0) - (a.speed || 0))
    else arr = arr.sort((a, b) => b.tags.length - a.tags.length || b.mainInflow - a.mainInflow) // 综合：多标签优先
    arr = arr.slice(0, 30)
    // 表头点击排序（覆盖默认榜单排序）
    if (colSort) {
      const { key, dir } = colSort
      arr = [...arr].sort((a, b) => {
        const va = Number(a[key]) || 0, vb = Number(b[key]) || 0
        return dir === 'asc' ? va - vb : vb - va
      })
    }
    return arr
  }, [zt, movers, speed, tab, colSort])

  const tabs = [['hot', '综合精选'], ['limit', '涨停连板'], ['inflow', '主力抢筹'], ['speed', '涨速异动']]

  return (
    <section className="panel candidate-pool">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="fire" size={16} /> 今日精选候选池</div>
        <div className="tabs">
          {tabs.map(([k, t]) => (
            <button
              key={k}
              type="button"
              className={'tab' + (tab === k ? ' active' : '')}
              aria-pressed={tab === k}
              onClick={() => { setTab(k); setColSort(null) }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div
        className="scroll data-table-scroll data-table-scroll-lg"
        role="region"
        aria-label="今日精选候选池表格"
        tabIndex="0"
      >
        <table className="tbl candidate-pool-table">
          <colgroup>
            <col className="candidate-col-name" />
            <col className="candidate-col-price" />
            <col className="candidate-col-pct" />
            <col className="candidate-col-signal" />
            <col className="candidate-col-flow" />
            <col className="candidate-col-action" />
          </colgroup>
          <thead>
            <tr><th>名称</th><Th label="现价" k="price" /><Th label="涨幅" k="pct" /><th>信号</th><Th label="主力/封资" k="mainInflow" /><th style={{ textAlign: 'center' }}>操作</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const added = book.plan.some((x) => x.code === s.code)
              return (
                <tr key={s.code}>
                  <td>
                      <StockName
                        code={s.code}
                        name={s.name}
                        showTags={false}
                        className="candidate-stock-name"
                      />
                  </td>
                  <td className={pctClass(s.pct)}>{s.price ? fmtRaw(s.price) : '--'}</td>
                  <td className={pctClass(s.pct)}>{fmtPct(s.pct)}</td>
                  <td>
                    {s.tags.slice(0, 3).map((t, i) => (
                      <span key={i} className={'sig-tag' + (t.includes('板') || t === '涨停' ? ' lu' : t === '主力抢筹' ? ' in' : ' sp')}>{t}</span>
                    ))}
                  </td>
                  <td className={s.mainInflow >= 0 ? 'red' : 'green'}>{s.mainInflow ? fmtInflow(s.mainInflow) : '--'}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button className={'chip-btn' + (added ? ' done' : '')} disabled={added} onClick={() => planStore.addPlan({ code: s.code, name: s.name })}>
                      <Icon name={added ? 'check' : 'plus'} size={13} />{added ? '已加' : '加自选'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && <tr><td colSpan={6} className="empty">暂无数据，开盘后逐步更新</td></tr>}
          </tbody>
        </table>
        <div className="legend table-note">
          综合精选按信号重叠度排序 · 点表头「现价/涨幅/主力」切换正倒序 · 点名称看详情K线 · 点「加自选」进入计划
        </div>
      </div>
    </section>
  )
}
