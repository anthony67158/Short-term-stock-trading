import { useState, useEffect, useRef } from 'react'
import Icon from './Icon'
import Md from './Md'
import { fetchDailyReport } from '../ai'
import { planStore } from '../planStore'
import { useAiSearchConfig } from '../aiSearchConfigStore'
import DailyReportSchedule from './DailyReportSchedule'
import SearchReference from './SearchReference'
import StockName from './StockName'

// ============ 全市场投资策略日报（抽屉）============
// 早/午/晚三场次；公告、行情、新闻与豆包搜索先形成证据包，再由 LLM 撰写；OSS 按账号/日期/场次缓存。
const SESSIONS = [
  { key: 'morning', label: '盘前早报' },
  { key: 'noon', label: '午间午报' },
  { key: 'evening', label: '收盘晚报' },
]
function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
function autoSession() { const d = nowBJ(); const hm = d.getHours() * 60 + d.getMinutes(); if (hm < 690) return 'morning'; if (hm < 900) return 'noon'; return 'evening' }
const rateTone = (r) => (String(r).includes('多') ? 'red' : String(r).includes('空') ? 'green' : 'muted')

function EvidenceIds({ ids }) {
  if (!Array.isArray(ids) || !ids.length) return null
  return (
    <span className="dr-evidence-ids" aria-label={`证据 ${ids.join('、')}`}>
      {ids.slice(0, 4).join(' · ')}
    </span>
  )
}

export default function DailyReport({ onClose }) {
  const [session, setSession] = useState(autoSession)
  const [state, setState] = useState({}) // {loading,phase}|{data}|{error} per session cached in memory
  const cacheRef = useRef({}) // session -> result
  const abortRef = useRef(null)
  const loadSeqRef = useRef(0)
  const searchConfig = useAiSearchConfig()
  const [scheduleOpen, setScheduleOpen] = useState(false)

  const load = async (sess, refresh) => {
    if (!refresh && cacheRef.current[sess]) { setState({ data: cacheRef.current[sess] }); return }
    if (abortRef.current) abortRef.current.abort()
    const sequence = ++loadSeqRef.current
    setState({ loading: true, phase: '正在准备日报…' })
    const ctrl = new AbortController(); abortRef.current = ctrl
    const book = planStore.get()
    const holdings = (book.holding || []).map((h) => ({
      code: h.code,
      name: h.name,
      industry: h.industry,
      concept: h.concept,
    }))
    const watchlist = (book.plan || []).map((item) => ({
      code: item.code,
      name: item.name,
      industry: item.industry,
      concept: item.concept,
      star: item.star === true,
    }))
    // 去重持仓
    const seen = new Set(); const uniq = holdings.filter((h) => (seen.has(h.code) ? false : seen.add(h.code)))
    const r = await fetchDailyReport({
      session: sess,
      holdings: uniq,
      watchlist,
      refresh,
      signal: ctrl.signal,
      onPhase: (p) => {
        if (sequence === loadSeqRef.current) {
          setState((s) => (s.loading ? { ...s, phase: p.text } : s))
        }
      },
    })
    if (sequence !== loadSeqRef.current) return
    if (r && r.ok) { cacheRef.current[sess] = r; setState({ data: r }) }
    else setState({ error: (r && r.error) || '生成失败' })
  }
  useEffect(() => {
    cacheRef.current = {}
    load(session)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, searchConfig.enabled, searchConfig.updatedAt])
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort() }, [])

  const r = state.data
  const rep = r && r.report
  const dt = r && r.data
  const newsRefs = (r?.newsRefs || []).filter(
    (item) => item?.kind !== 'doubao_search',
  )

  return (
    <div className="modal-mask mask-drawer" onClick={onClose}>
      <div className="dr-drawer" role="dialog" aria-modal="true" aria-label="全市场投资策略日报" onClick={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div className="dr-head">
          <div className="dr-title"><Icon name="clipboard" size={17} /> 全市场投资策略日报</div>
          <div className="dr-head-actions">
            {r && <button className="icon-btn" title="刷新本场次" onClick={() => load(session, true)}><Icon name="refresh" size={15} /></button>}
            <button
              type="button"
              className={'icon-btn dr-auto-trigger' + (scheduleOpen ? ' active' : '')}
              aria-label="设置日报自动生成时间"
              aria-expanded={scheduleOpen}
              title="自动生成设置"
              onClick={() => setScheduleOpen((open) => !open)}
            >
              <Icon name="clock" size={15} />
            </button>
            <button type="button" className="modal-close" aria-label="关闭策略日报" onClick={onClose}><Icon name="close" size={16} /></button>
          </div>
        </div>
        {/* 场次切换 */}
        <div className="dr-sessions">
          {SESSIONS.map((s) => (
            <button key={s.key} className={'dr-sess-tab' + (session === s.key ? ' on' : '')} onClick={() => setSession(s.key)}>{s.label}</button>
          ))}
          {r && (
            <span className="dr-meta">
              {r.day} · {r.cached ? '已缓存' : '最新生成'}
              {r.degraded ? ' · 证据降级版' : ''}
            </span>
          )}
        </div>

        {scheduleOpen && <DailyReportSchedule />}

        <div className="dr-body">
          {state.loading && (
            <div className="dr-loading"><Icon name="refresh" size={14} className="spin" /> {state.phase || '生成中…'}</div>
          )}
          {state.error && <div className="dr-error">{state.error} <button type="button" className="expand-btn" onClick={() => load(session, true)}>重试</button></div>}

          {rep && (
            <>
              {/* 市场快照条 */}
              {dt && (
                <div className="dr-snapshot">
                  {(dt.aIndices || []).map((i, k) => <span key={'a' + k} className="dr-idx"><span className="dr-idx-n">{i.name}</span><b className={i.pct >= 0 ? 'red' : 'green'}>{i.pct >= 0 ? '+' : ''}{i.pct}%</b></span>)}
                  {(dt.overseas || []).map((i, k) => <span key={'o' + k} className="dr-idx"><span className="dr-idx-n">{i.label}</span><b className={i.pct >= 0 ? 'red' : 'green'}>{i.pct >= 0 ? '+' : ''}{i.pct}%</b></span>)}
                  {(dt.commodities || []).map((i, k) => <span key={'c' + k} className="dr-idx"><span className="dr-idx-n">{i.label}</span><b className={i.pct >= 0 ? 'red' : 'green'}>{i.pct >= 0 ? '+' : ''}{i.pct}%</b></span>)}
                </div>
              )}
              {/* 总览 */}
              {rep.overview && <div className="dr-overview"><Md text={rep.overview} /></div>}
              {rep.overseas && <div className="dr-block"><div className="dr-block-t"><Icon name="compass" size={13} /> 隔夜海外 / 商品</div><div className="dr-block-c"><Md text={rep.overseas} /></div></div>}

              {Array.isArray(rep.events) && rep.events.length > 0 && (
                <div className="dr-block dr-events">
                  <div className="dr-block-t"><Icon name="bolt" size={13} /> 重大事件雷达</div>
                  {rep.events.map((event, index) => (
                    <article className="dr-event" key={`${event.title}-${index}`}>
                      <div className="dr-event-head">
                        <strong>{event.title}</strong>
                        {event.category && <span>{event.category}</span>}
                        <EvidenceIds ids={event.evidenceIds} />
                      </div>
                      {event.impact && <p>{event.impact}</p>}
                    </article>
                  ))}
                </div>
              )}

              {/* 持仓与重点自选信息(公告优先) */}
              {Array.isArray(rep.holdings) && rep.holdings.length > 0 && (
                <div className="dr-block dr-hold">
                  <div className="dr-block-t"><Icon name="wallet" size={13} /> 重点个股 · 公告与信息</div>
                  {rep.holdings.map((h, k) => (
                    <div className="dr-hold-item" key={k}>
                      <div className="dr-hold-head">
                        <StockName code={h.code}
                          name={h.name}
                          className="dr-hold-name"
                        />
                        <span>{h.scope === 'watchlist' ? '自选' : '持仓'}</span>
                        <EvidenceIds ids={h.evidenceIds} />
                      </div>
                      <div className="dr-hold-info">{h.info}</div>
                      {h.impact && <div className="dr-hold-impact">{h.impact}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* 板块 */}
              {Array.isArray(rep.sectors) && (
                <div className="dr-sectors">
                  <div className="dr-block-t"><Icon name="layers" size={13} /> 全板块研判</div>
                  {rep.sectors.map((s, k) => (
                    <div className={'dr-sector tone-' + rateTone(s.rating)} key={k}>
                      <div className="dr-sector-head">
                        <span className="dr-sector-name">{s.name}</span>
                        {s.rating && <span className={'dr-rating ' + rateTone(s.rating)}>{s.rating}</span>}
                        <EvidenceIds ids={s.evidenceIds} />
                      </div>
                      {s.view && <div className="dr-sector-view">{s.view}</div>}
                      {s.evidence && <div className="dr-row"><span className="dr-k ev">证据</span><span>{s.evidence}</span></div>}
                      {s.picks && <div className="dr-row"><span className="dr-k pick">关注</span><span>{s.picks}</span></div>}
                      {s.strategy && <div className="dr-row"><span className="dr-k st">策略</span><span>{s.strategy}</span></div>}
                      {s.risk && <div className="dr-row"><span className="dr-k rk">风险</span><span>{s.risk}</span></div>}
                    </div>
                  ))}
                </div>
              )}

              {/* 整体策略 + 风险 */}
              {rep.strategy && <div className="dr-block dr-final"><div className="dr-block-t"><Icon name="target" size={13} /> 今日操作策略</div><div className="dr-block-c"><Md text={rep.strategy} /></div></div>}
              {Array.isArray(rep.risks) && rep.risks.length > 0 && (
                <div className="dr-block"><div className="dr-block-t"><Icon name="shield" size={13} /> 风险提示</div>{rep.risks.map((x, k) => <div key={k} className="dr-risk-item">· {x}</div>)}</div>
              )}
              <SearchReference reference={r.searchReference} />

              {/* 数据来源 */}
              {newsRefs.length > 0 && (
                <div className="dr-refs">
                  <div className="dr-refs-t">参考来源</div>
                  {newsRefs.map((n, k) => <a key={k} className="dr-ref" href={n.url} target="_blank" rel="noreferrer"><span className="dr-ref-d">{n.id ? `${n.id} · ` : ''}{n.date}</span>{n.title}</a>)}
                </div>
              )}
              <div className="dr-disclaimer">公司公告与监管政策优先；行情、资金和权威媒体用于交叉核验；豆包搜索摘要仅作线索。海外与商品可能延迟，仅供研究参考。</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
