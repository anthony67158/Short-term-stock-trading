import { useState, useEffect, useRef } from 'react'
import Icon from './Icon'
import Md from './Md'
import { fetchDailyReport } from '../ai'
import { planStore } from '../planStore'
import { openStockDetail } from '../detailStore'

// ============ 全市场投资策略日报（抽屉）============
// 早/午/晚三场次；数据来自开源免费接口(东财/腾讯/新浪)综合，LLM 撰写；Blob 按日+场次缓存。
const SESSIONS = [
  { key: 'morning', label: '盘前早报' },
  { key: 'noon', label: '午间午报' },
  { key: 'evening', label: '收盘晚报' },
]
function nowBJ() { const n = new Date(); return new Date(n.getTime() + (n.getTimezoneOffset() + 480) * 60000) }
function autoSession() { const d = nowBJ(); const hm = d.getHours() * 60 + d.getMinutes(); if (hm < 690) return 'morning'; if (hm < 900) return 'noon'; return 'evening' }
const rateTone = (r) => (String(r).includes('多') ? 'red' : String(r).includes('空') ? 'green' : 'muted')

export default function DailyReport({ onClose }) {
  const [session, setSession] = useState(autoSession)
  const [state, setState] = useState({}) // {loading,phase}|{data}|{error} per session cached in memory
  const cacheRef = useRef({}) // session -> result
  const abortRef = useRef(null)

  const load = async (sess, refresh) => {
    if (!refresh && cacheRef.current[sess]) { setState({ data: cacheRef.current[sess] }); return }
    setState({ loading: true, phase: '正在准备日报…' })
    const ctrl = new AbortController(); abortRef.current = ctrl
    const holdings = (planStore.get().holding || []).map((h) => ({ code: h.code, name: h.name }))
    // 去重持仓
    const seen = new Set(); const uniq = holdings.filter((h) => (seen.has(h.code) ? false : seen.add(h.code)))
    const r = await fetchDailyReport({ session: sess, holdings: uniq, refresh, signal: ctrl.signal, onPhase: (p) => setState((s) => (s.loading ? { ...s, phase: p.text } : s)) })
    if (r && r.ok) { cacheRef.current[sess] = r; setState({ data: r }) }
    else setState({ error: (r && r.error) || '生成失败' })
  }
  useEffect(() => { load(session) /* eslint-disable-next-line */ }, [session])
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort() }, [])

  const r = state.data
  const rep = r && r.report
  const dt = r && r.data

  return (
    <div className="modal-mask mask-drawer" onClick={onClose}>
      <div className="dr-drawer" onClick={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div className="dr-head">
          <div className="dr-title"><Icon name="clipboard" size={17} /> 全市场投资策略日报</div>
          <div className="dr-head-actions">
            {r && <button className="icon-btn" title="刷新本场次" onClick={() => load(session, true)}><Icon name="refresh" size={15} /></button>}
            <div className="modal-close" onClick={onClose}><Icon name="close" size={16} /></div>
          </div>
        </div>
        {/* 场次切换 */}
        <div className="dr-sessions">
          {SESSIONS.map((s) => (
            <button key={s.key} className={'dr-sess-tab' + (session === s.key ? ' on' : '')} onClick={() => setSession(s.key)}>{s.label}</button>
          ))}
          {r && <span className="dr-meta">{r.day} · {r.cached ? '已缓存' : '最新生成'}</span>}
        </div>

        <div className="dr-body">
          {state.loading && (
            <div className="dr-loading"><Icon name="refresh" size={14} className="spin" /> {state.phase || '生成中…'}</div>
          )}
          {state.error && <div className="dr-error">{state.error} <span className="expand-btn" onClick={() => load(session, true)}>重试</span></div>}

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
              {rep.overseas && <div className="dr-block"><div className="dr-block-t">🌏 隔夜海外 / 商品</div><div className="dr-block-c"><Md text={rep.overseas} /></div></div>}

              {/* 持仓股信息(醒目置前) */}
              {Array.isArray(rep.holdings) && rep.holdings.length > 0 && (
                <div className="dr-block dr-hold">
                  <div className="dr-block-t">📌 你的持仓 · 今日信息</div>
                  {rep.holdings.map((h, k) => (
                    <div className="dr-hold-item" key={k}>
                      <div className="dr-hold-name" onClick={() => h.code && openStockDetail(h.code, h.name)}>{h.name}</div>
                      <div className="dr-hold-info">{h.info}</div>
                      {h.impact && <div className="dr-hold-impact">{h.impact}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* 板块 */}
              {Array.isArray(rep.sectors) && (
                <div className="dr-sectors">
                  <div className="dr-block-t">📊 全板块研判</div>
                  {rep.sectors.map((s, k) => (
                    <div className={'dr-sector tone-' + rateTone(s.rating)} key={k}>
                      <div className="dr-sector-head">
                        <span className="dr-sector-name">{s.name}</span>
                        {s.rating && <span className={'dr-rating ' + rateTone(s.rating)}>{s.rating}</span>}
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
              {rep.strategy && <div className="dr-block dr-final"><div className="dr-block-t">🎯 今日操作策略</div><div className="dr-block-c"><Md text={rep.strategy} /></div></div>}
              {Array.isArray(rep.risks) && rep.risks.length > 0 && (
                <div className="dr-block"><div className="dr-block-t">⚠️ 风险提示</div>{rep.risks.map((x, k) => <div key={k} className="dr-risk-item">· {x}</div>)}</div>
              )}

              {/* 数据来源 */}
              {Array.isArray(r.newsRefs) && r.newsRefs.length > 0 && (
                <div className="dr-refs">
                  <div className="dr-refs-t">参考来源</div>
                  {r.newsRefs.map((n, k) => <a key={k} className="dr-ref" href={n.url} target="_blank" rel="noreferrer"><span className="dr-ref-d">{n.date}</span>{n.title}</a>)}
                </div>
              )}
              <div className="dr-disclaimer">数据来自东财/腾讯/新浪等公开免费接口，海外与商品多为延迟/昨收，仅供研究参考，非投资建议。</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
