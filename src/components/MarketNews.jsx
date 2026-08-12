import { useState, useEffect, useRef } from 'react'
import Icon from './Icon'
import DailyReport from './DailyReport'
import { fetchMarketNews } from '../ai'

// ============ 盘面研究·外部宏观经济分析（宏观要闻 + 7×24 快讯 + 策略日报入口）============
// 把原先散落的日报/快讯集中到盘面研究，统一作为"外部宏观经济分析"的消息面来源。
// 数据源：财联社系/金十/新浪 7×24（/api/market?news=1 聚合），全部公开免费接口。
const REFRESH_MS = 60000
const srcTone = (s) => {
  if (/财联社|金十/.test(s)) return 'hot'
  if (/新浪/.test(s)) return 'sina'
  if (/华尔街|东方财富/.test(s)) return 'muted'
  return 'muted'
}
// 简单相对时间：news 只给到日期，退化为"今日/日期"标注
const dayTag = (d) => {
  if (!d) return ''
  const today = new Date(); const y = today.getFullYear()
  const md = String(d).slice(5)
  const isToday = String(d) === `${y}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return isToday ? '今日' : (md || d)
}

export default function MarketNews() {
  const [state, setState] = useState({ loading: true })
  const [reportOpen, setReportOpen] = useState(false)
  const timerRef = useRef(null)

  const load = async () => {
    const r = await fetchMarketNews()
    if (r && r.ok) setState({ data: r })
    else setState((s) => (s.data ? s : { error: (r && r.error) || '加载失败' }))
  }
  useEffect(() => {
    load()
    timerRef.current = setInterval(load, REFRESH_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const d = state.data || {}
  const macro = d.macro || []
  const flashes = d.flashes || []

  return (
    <div className="panel mn-panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="news" size={16} /> 外部宏观经济分析
          <span className="sub-name">宏观要闻 · 7×24 快讯 · 全市场消息面</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setReportOpen(true)}>
            <Icon name="clipboard" size={13} /> 策略日报
          </button>
          <button className="icon-btn" title="刷新快讯" onClick={load}><Icon name="refresh" size={14} /></button>
        </div>
      </div>
      {reportOpen && <DailyReport onClose={() => setReportOpen(false)} />}

      {state.loading && <div className="mn-loading"><Icon name="refresh" size={13} className="spin" /> 正在加载外部消息面…</div>}
      {state.error && <div className="mn-error">{state.error} <button type="button" className="expand-btn" onClick={load}>重试</button></div>}

      {(macro.length > 0 || flashes.length > 0) && (
        <div className="mn-grid">
          {/* 宏观要闻（带链接的深度稿件）*/}
          <div className="mn-col">
            <div className="mn-col-t">📰 宏观要闻</div>
            {macro.length === 0 && <div className="mn-empty">暂无</div>}
            {macro.map((n, k) => (
              <a key={k} className="mn-macro" href={n.url || undefined} target="_blank" rel="noreferrer">
                <span className="mn-macro-d">{dayTag(n.date)}</span>
                <span className="mn-macro-t">{n.title}</span>
              </a>
            ))}
          </div>

          {/* 7×24 快讯（财联社系/金十/新浪）*/}
          <div className="mn-col">
            <div className="mn-col-t">⚡ 7×24 快讯</div>
            {flashes.length === 0 && <div className="mn-empty">暂无</div>}
            <div className="mn-flash-list">
              {flashes.map((n, k) => {
                const inner = (
                  <>
                    <span className={'mn-src ' + srcTone(n.src)}>{n.src}</span>
                    <span className="mn-flash-t">{n.title}</span>
                  </>
                )
                return n.url
                  ? <a key={k} className="mn-flash" href={n.url} target="_blank" rel="noreferrer">{inner}</a>
                  : <div key={k} className="mn-flash">{inner}</div>
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mn-disclaimer">数据来自财联社系/金十/新浪财经等公开免费接口，海外多为延迟，仅供研究参考，非投资建议。AI 操作建议/复盘/加减仓/问答会自动参考这些外部消息面。</div>
    </div>
  )
}
