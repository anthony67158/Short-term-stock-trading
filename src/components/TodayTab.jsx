import { useState, useMemo } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import LimitPool from './LimitPool'
import { usePolling } from '../hooks'
import { callAI } from '../ai'
import { planStore, usePlanStore } from '../planStore'
import { aiStore } from '../aiStore'
import { fmtPct, pctClass, fmtInflow, fmtNum } from '../format'

// ============ 今日选股 Tab：今天买什么 ============
export default function TodayTab({ interval, market, sectors, snapshot }) {
  const zt = usePolling('/api/limitup?kind=zt', interval)
  const movers = usePolling('/api/movers?kind=inflow', interval)
  const speed = usePolling('/api/movers?kind=speed', interval)

  return (
    <div className="today">
      <MarketLight market={market} sectors={sectors} snapshot={snapshot} />
      <DailyPlay snapshot={snapshot} />
      <CandidatePool zt={zt.data} movers={movers.data} speed={speed.data} sectors={sectors} />
      <LimitPool interval={interval} />
    </div>
  )
}

// ---------- 大盘盘面（指数全景 + 情绪红绿灯 + 今日操作建议）----------
function MarketLight({ market, sectors, snapshot }) {
  const b = (market && market.breadth) || {}
  const idx = (market && market.indices) || []
  const ratio = b.down ? b.up / b.down : (b.up ? 9 : 1)
  // 简单情绪判定
  let light = 'yellow', text = '多空胶着，轻仓试探'
  const zt = b.limitUp || 0, dt = b.limitDown || 0
  if (ratio >= 1.5 && zt > dt * 3) { light = 'green'; text = '情绪偏暖，可积极参与' }
  else if (ratio < 0.7 || dt > zt) { light = 'red'; text = '情绪转弱，控制仓位' }
  const topSector = (sectors && sectors.list && sectors.list[0]) || null

  // AI 动态盘前建议：结合指数/板块/涨停梯队/异动，不只看红绿灯
  const [advice, setAdvice] = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const runAdvice = async () => {
    setLoading(true); setErr(null)
    try {
      const s = snapshot()
      const payload = {
        breadth: s.market?.breadth || {},
        indices: (s.market?.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
        topSectors: (s.sectors?.list || []).slice(0, 8).map((x) => ({ name: x.name, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2), lead: x.leadName })),
        limitUp: (s.limitPool?.list || []).slice(0, 8).map((x) => ({ name: x.name, code: x.code, lbc: x.lbc, sector: x.sector })),
        movers: (s.movers?.list || []).slice(0, 8).map((x) => ({ name: x.name, code: x.code, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2) })),
      }
      const r = await callAI('daily', payload)
      if (r.ok) setAdvice(r.result)
      else setErr(r.error || 'AI 调用失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false) }
  }

  return (
    <div className="panel market-board">
      <div className="panel-head">
        <div className="panel-title"><Icon name="pulse" size={16} /> 大盘盘面 <span className="sub-name">开盘先看势，定今日仓位</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-primary" onClick={runAdvice} disabled={loading}>
            <Icon name={loading ? 'refresh' : 'spark'} size={13} className={loading ? 'spin' : ''} />
            {loading ? '分析中' : (advice ? '重新建议' : 'AI建议')}
          </button>
          <div className={'mb-light ' + light}><span className="orb-dot" />{light === 'green' ? '可以做' : light === 'red' ? '谨慎/空仓' : '轻仓试探'} · {text}</div>
        </div>
      </div>

      {/* 今日操作建议：AI 动态建议优先；没有时再退回规则版建议 */}
      {(() => {
        const fallback = light === 'green'
          ? { icon: 'target', title: '今日可积极做短线', sub: '顺势选强势主线龙头开新仓；持仓正常做T滚成本', tone: 'green' }
          : light === 'red'
          ? { icon: 'shield', title: '今日不宜开新仓', sub: '暂停短线建仓，空仓观望；仅在已有持仓上谨慎做T降成本', tone: 'red' }
          : { icon: 'gauge', title: '今日轻仓 + 以做T为主', sub: '短线只试仓最强龙头、控制仓位；重点在持仓上高抛低吸做T', tone: 'yellow' }
        const plan = advice
          ? {
              icon: advice.light === 'green' ? 'target' : advice.light === 'red' ? 'shield' : 'gauge',
              title: advice.verdict || advice.canTrade || fallback.title,
              sub: `主攻 ${advice.direction || '--'}${advice.position ? ' · 仓位 ' + advice.position : ''}${advice.risk ? ' · 风险 ' + advice.risk : ''}`,
              tone: advice.light || fallback.tone,
            }
          : fallback
        return (
          <div className={'mb-plan ' + plan.tone}>
            <span className="mb-plan-icon"><Icon name={plan.icon} size={18} /></span>
            <div className="mb-plan-txt">
              <div className="mb-plan-title">{plan.title}</div>
              <div className="mb-plan-sub">{plan.sub}</div>
              {err && <div className="err" style={{ marginTop: 3 }}>{err}</div>}
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
              <div className={'mb-idx-price ' + pctClass(i.pct)}>{i.price ? fmtNum(i.price) : '--'}</div>
              <div className={'mb-idx-pct ' + pctClass(i.pct)}>{fmtPct(i.pct)}</div>
            </div>
          ))}
        </div>
        {/* 情绪指标 */}
        <div className="mb-stats">
          <div className="mb-stat">
            <div className="mb-stat-label">涨/跌停</div>
            <div className="mb-stat-val"><span className="red">{zt}</span><span className="sep">/</span><span className="green">{dt}</span></div>
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
    </div>
  )
}

// ---------- AI 今日操盘（一键出决策+候选） ----------
function DailyPlay({ snapshot }) {
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState(null)
  const [err, setErr] = useState(null)
  const book = usePlanStore()

  const run = async () => {
    setLoading(true); setErr(null)
    try {
      const s = snapshot()
      const payload = {
        breadth: s.market?.breadth || {},
        indices: (s.market?.indices || []).map((i) => ({ name: i.name, pct: i.pct })),
        topSectors: (s.sectors?.list || []).slice(0, 10).map((x) => ({ name: x.name, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2), lead: x.leadName })),
        limitUp: (s.limitPool?.list || []).slice(0, 12).map((x) => ({ name: x.name, code: x.code, lbc: x.lbc, sector: x.sector })),
        movers: (s.movers?.list || []).slice(0, 12).map((x) => ({ name: x.name, code: x.code, pct: x.pct, mainInflowYi: +(x.mainInflow / 1e8).toFixed(2) })),
      }
      const r = await callAI('daily', payload)
      if (r.ok) setRes(r.result); else setErr(r.error || 'AI 调用失败')
    } catch (e) { setErr(String(e.message || e)) }
    finally { setLoading(false) }
  }

  const lightClass = res ? (res.light || 'yellow') : ''
  return (
    <div className="play-card">
      <div className="play-head">
        <div className="play-title">
          <Icon name="target" size={18} />
          <span>AI 今日操盘</span>
          <span className="play-sub">一键给出：能不能做 · 主攻方向 · 可执行候选</span>
        </div>
        <button className="btn btn-primary" onClick={run} disabled={loading}>
          <Icon name={loading ? 'refresh' : 'spark'} size={15} className={loading ? 'spin' : ''} />
          {loading ? '分析中' : (res ? '重新分析' : '开始分析')}
        </button>
      </div>

      <div className="play-body">
        {err && <div className="err">{err}</div>}
        {!res && !err && !loading && (
          <div className="play-hint">综合大盘情绪、板块资金、涨停梯队、盘中异动，给你一份今日可执行的短线操盘计划。</div>
        )}
        {loading && <div className="play-hint">正在综合多维数据，生成操盘计划…</div>}
        {res && (
          <>
            <div className={'play-verdict ' + lightClass}>
              <div className="pv-badge">{res.canTrade || '—'}</div>
              <div className="pv-text">
                <div className="pv-main">{res.verdict}</div>
                <div className="pv-meta">
                  <span>主攻：<b>{res.direction}</b></span>
                  {res.position && <span>仓位：<b>{res.position}</b></span>}
                </div>
              </div>
            </div>

            {Array.isArray(res.candidates) && res.candidates.length > 0 && (
              <div className="cand-grid">
                {res.candidates.map((c, i) => {
                  const added = book.plan.some((x) => x.code === c.code)
                  return (
                    <div className="cand-card" key={i}>
                      <div className="cand-top">
                        <div className="cand-name">
                          <StockName code={c.code} name={c.name}><span>{c.name}<span className="cand-code">{c.code}</span></span></StockName>
                        </div>
                        <button
                          className={'chip-btn' + (added ? ' done' : '')}
                          disabled={added}
                          onClick={() => planStore.addPlan({ code: c.code, name: c.name }, c.reason)}
                        >
                          <Icon name={added ? 'check' : 'plus'} size={13} />{added ? '已加入' : '加自选'}
                        </button>
                      </div>
                      <div className="cand-row"><span className="cand-tag reason">逻辑</span>{c.reason}</div>
                      {c.buyPoint && <div className="cand-row"><span className="cand-tag buy">买点</span>{c.buyPoint}</div>}
                      <div className="cand-foot">
                        {c.expect && <span className="cand-expect">次日：{c.expect}</span>}
                        {c.stop && <span className="cand-stop">止损：{c.stop}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {res.risk && (
              <div className="play-risk"><Icon name="shield" size={14} /><span>{res.risk}</span></div>
            )}
            <div className="play-disclaimer">AI 基于实时数据的客观分析，仅供研究参考，非投资建议</div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 精选候选池（涨停/异动/涨速/资金 合成带标签列表） ----------
function CandidatePool({ zt, movers, speed, sectors }) {
  const [tab, setTab] = useState('hot') // hot(综合) | limit | inflow | speed
  const book = usePlanStore()

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
    return arr.slice(0, 30)
  }, [zt, movers, speed, tab])

  const tabs = [['hot', '综合精选'], ['limit', '涨停连板'], ['inflow', '主力抢筹'], ['speed', '涨速异动']]

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="fire" size={16} /> 今日精选候选池</div>
        <div className="tabs">
          {tabs.map(([k, t]) => (
            <div key={k} className={'tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{t}</div>
          ))}
        </div>
      </div>
      <div className="scroll" style={{ maxHeight: 520 }}>
        <table className="tbl">
          <thead>
            <tr><th>名称</th><th>现价</th><th>涨幅</th><th>信号</th><th>主力/封资</th><th style={{ textAlign: 'center' }}>操作</th></tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const added = book.plan.some((x) => x.code === s.code)
              return (
                <tr key={s.code}>
                  <td>
                    <StockName code={s.code} name={s.name}><span>{s.name}<span className="sub-name">{s.code}</span></span></StockName>
                  </td>
                  <td className={pctClass(s.pct)}>{s.price ? fmtNum(s.price) : '--'}</td>
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
        <div className="legend" style={{ padding: '8px 14px' }}>
          综合精选按信号重叠度排序（同时涨停+主力抢筹+涨速的最强）· 点名称看详情K线 · 点「加自选」进入计划买入
        </div>
      </div>
    </div>
  )
}
