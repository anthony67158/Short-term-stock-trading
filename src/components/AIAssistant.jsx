import { useState, useRef, useEffect } from 'react'
import { useAIStore, aiStore } from '../aiStore'
import { openStockDetail } from '../detailStore'
import { chatStore } from '../chatStore'
import { callAI } from '../ai'
import Icon from './Icon'
import Md from './Md'

// ============ 统一 AI 助手：一个入口，对话为核心 ============
// 能力：个股多轮问答(RAG+新闻) + 快捷指令(全盘扫描/盘面复盘/板块选股/个股诊断)
// 对话按日期持久化，单日上下文连贯，可按天查看/删除历史

export default function AIAssistant({ snapshot }) {
  const { open, stock, sector, intent, seq, prefill, prefillSeq } = useAIStore()
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const today = chatStore.today()
  const [day, setDay] = useState(today) // 当前查看的日期
  const [msgs, setMsgs] = useState(() => chatStore.load(today)) // 从今天的持久化对话恢复
  const [histOpen, setHistOpen] = useState(false) // 历史面板
  const [histTick, setHistTick] = useState(0) // 历史列表刷新
  const scrollRef = useRef(null)
  const inputRef = useRef(null) // 输入框，用于预填后聚焦
  const abortRef = useRef(null) // 当前分析的中止控制器
  const isToday = day === today

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [msgs, loading])

  // 输入框随内容自动增高（多行预填/编辑时不遮挡）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [q, open])

  // 消息变化时，持久化到「当天」（仅当查看的是今天且非加载态时写入）
  useEffect(() => {
    if (isToday) chatStore.save(msgs, today)
    // eslint-disable-next-line
  }, [msgs])

  // 切换查看的日期
  const viewDay = (d) => { setDay(d); setMsgs(chatStore.load(d)); setHistOpen(false) }

  // 响应外部意图（从页面点"问AI"→直接以自然语言提问该股）
  useEffect(() => {
    if (!intent) return
    if (intent === 'diagnose' && stock) ask(`分析一下${stock.name}(${stock.code})，资金面、量价、消息面都看看，短线怎么操作`)
    aiStore.consumeIntent()
    // eslint-disable-next-line
  }, [seq])

  // 响应预填：把文本填入输入框但不发送，聚焦并把光标移到末尾，由用户编辑后手动发
  useEffect(() => {
    if (!prefill) return
    // 若在看历史，切回今天再填
    if (!isToday) { setDay(today); setMsgs(chatStore.load(today)) }
    setQ(prefill)
    aiStore.consumePrefill()
    setTimeout(() => {
      const el = inputRef.current
      if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n) } catch { /* noop */ } el.scrollTop = el.scrollHeight }
    }, 60)
    // eslint-disable-next-line
  }, [prefillSeq])

  const pushUser = (content) => setMsgs((m) => [...m, { role: 'user', kind: 'text', content }])
  const pushAI = (msg) => setMsgs((m) => [...m, { role: 'assistant', ...msg }])

  // ===== 核心：Agent 对话（自主调用工具，支持开放性问题 + 个股问答） =====
  const ask = async (question) => {
    const query = (question || q).trim()
    if (!query || loading) return
    setQ('')
    // 若正在查看历史某天，提问自动切回今天继续对话
    let base = msgs
    if (!isToday) { base = chatStore.load(today); setDay(today); setMsgs(base) }
    // 传当天完整文本上下文给后端，保证单日对话连贯（取最近若干轮）
    const history = base.filter((m) => m.kind === 'text').map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })).slice(-12)
    pushUser(query)
    setLoading(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: query, history, stock: stock || null }),
        signal: ctrl.signal,
      })
      // 健壮解析：后端超时/崩溃时 Vercel 返回纯文本而非 JSON，先读文本再尝试解析
      const raw = await res.text()
      let j = null
      try { j = JSON.parse(raw) } catch { /* 非 JSON */ }
      if (!j) {
        const hint = res.status === 504 || /timed? ?out|An error occurred/i.test(raw)
          ? '这个问题查询的数据较多，分析超时了。可以换个更聚焦的问法（如只问某一只票、或某一个板块），我会更快返回。'
          : `服务暂时不可用（${res.status}），请稍后重试。`
        pushAI({ kind: 'text', content: '抱歉，' + hint })
      } else if (j.ok) {
        pushAI({ kind: 'text', content: j.answer, toolTrace: j.toolTrace || [], theoryRefs: j.theoryRefs || [] })
      } else {
        pushAI({ kind: 'text', content: '抱歉，' + (j.error || '分析失败') })
      }
    } catch (e) {
      if (e.name === 'AbortError') pushAI({ kind: 'text', content: '已停止本次分析。' })
      else pushAI({ kind: 'text', content: '抱歉，网络异常：' + String(e.message || e) })
    }
    finally { setLoading(false); abortRef.current = null }
  }

  // 停止正在进行的分析
  const stop = () => { if (abortRef.current) abortRef.current.abort() }

  return (
    <>
      {/* 悬浮球 */}
      <button className={'ai-fab' + (open ? ' hidden' : '')} onClick={() => aiStore.open()} title="AI 助手">
        <span className="ai-fab-spark"><Icon name="spark" size={18} /></span>
        <span className="ai-fab-text">AI 助手</span>
      </button>

      {/* 抽屉 */}
      {open && (
        <div className="ai-drawer">
          <div className="ai-drawer-head">
            <div className="ai-drawer-title">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Icon name="spark" size={16} /> AI 操盘助手</span>
              <span className="ai-focus muted">{isToday ? '直接提问，我会自己查数据' : `查看 ${day} 的对话（只读）`}</span>
            </div>
            <div className="ai-head-actions">
              <button className="icon-btn" title="历史对话" onClick={() => setHistOpen((v) => !v)}><Icon name="history" size={14} /></button>
              {msgs.length > 0 && isToday && <button className="icon-btn" title="清空今天对话" onClick={() => { if (confirm('清空今天的对话？')) { setMsgs([]); chatStore.removeDay(today) } }}><Icon name="trash" size={14} /></button>}
              <div className="modal-close" onClick={() => aiStore.close()}><Icon name="close" size={16} /></div>
            </div>
          </div>

          {/* 历史对话面板（按天） */}
          {histOpen && (
            <div className="ai-hist">
              <div className="ai-hist-head">历史对话（按天）{!isToday && <span className="ai-hist-back" onClick={() => viewDay(today)}>回到今天</span>}</div>
              {chatStore.days().length === 0 && <div className="ai-hist-empty">暂无历史对话</div>}
              {chatStore.days().map((d) => {
                const s = chatStore.summary(d)
                return (
                  <div key={d} className={'ai-hist-item' + (d === day ? ' active' : '')}>
                    <span className="ai-hist-main" onClick={() => viewDay(d)}>
                      <b>{d === today ? '今天' : d}</b>
                      <span className="ai-hist-sub">{s.count}条 · {s.first}</span>
                    </span>
                    <span className="del" title="删除这一天" onClick={() => {
                      if (confirm(`删除 ${d} 的全部对话？`)) {
                        chatStore.removeDay(d)
                        if (d === day) { const t = today; setDay(t); setMsgs(chatStore.load(t)) }
                        setHistTick((n) => n + 1)
                      }
                    }}>×</span>
                  </div>
                )
              })}
            </div>
          )}

          {/* 快捷能力：都是自然语言问题，点了直接问 */}
          <div className="ai-quick">
            <button className="ai-chip" onClick={() => ask('复盘今日盘面：总结市场情绪冷热、最强主线板块、明日需注意的风险，并给一句操作建议')} disabled={loading}><Icon name="brain" size={13} /> 盘面复盘</button>
            <button className="ai-chip" onClick={() => ask('现在能不能做短线？帮我看下今日大盘情绪和主攻方向')} disabled={loading}><Icon name="gauge" size={13} /> 今日能做吗</button>
            <button className="ai-chip" onClick={() => ask('综合资金、涨停、异动，给我今日 TOP3 方向和代表股')} disabled={loading}><Icon name="target" size={13} /> 全盘扫描</button>
            <button className="ai-chip" onClick={() => ask('现在主力在抢筹哪些方向？帮我推荐3只短线标的，说明买点和风险')} disabled={loading}><Icon name="fire" size={13} /> 推荐短线</button>
            <button className="ai-chip" onClick={() => ask('今天哪个板块最强？龙头是谁？从里面挑2-3只票')} disabled={loading}><Icon name="layers" size={13} /> 最强板块</button>
          </div>

          {/* 对话流 */}
          <div className="ai-chat" ref={scrollRef}>
            {msgs.length === 0 && !loading && (
              <div className="ai-welcome">
                <div className="ai-welcome-title">我是你的短线操盘助手</div>
                <div className="ai-welcome-sub">直接跟我说话就行——想分析哪只票就说名字（如"分析寒武纪"），想选股、看板块、问大盘都可以，我会自己查数据回答。</div>
                <div className="qa-presets" style={{ marginTop: 14 }}>
                  <span className="qa-preset" onClick={() => ask('分析一下寒武纪，资金面、基本面、消息面都看看')}>分析寒武纪</span>
                  <span className="qa-preset" onClick={() => ask('帮我筛选涨幅5%以内、量比大于2、主力净流入靠前的票')}>按条件选股</span>
                  <span className="qa-preset" onClick={() => ask('半导体板块现在资金和情绪怎么样？值得关注吗')}>问某个板块</span>
                  <span className="qa-preset" onClick={() => ask('今天有哪些连板龙头？梯队健康吗')}>看连板梯队</span>
                </div>
              </div>
            )}
            {msgs.map((m, i) => <Message key={i} m={m} />)}
            {loading && (
              <div className="qa-msg assistant"><div className="qa-bubble">
                <div className="ai-loading"><span className="ai-loading-dot" /><span className="ai-loading-dot" /><span className="ai-loading-dot" />分析中…<span className="ai-stop-link" onClick={stop}>停止</span></div>
              </div></div>
            )}
          </div>

          {/* 提问输入 */}
          <div className="ai-input-row">
            <textarea
              ref={inputRef}
              className="wl-input ai-textarea" style={{ flex: 1, width: 'auto' }}
              rows={1}
              placeholder={isToday ? '分析某只票 / 选股 / 问板块 / 问大盘…（Enter 发送，Shift+Enter 换行）' : '正在查看历史，输入即回到今天继续对话'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
              disabled={loading}
            />
            {loading
              ? <button className="btn btn-danger" onClick={stop}><Icon name="close" size={14} />停止</button>
              : <button className="btn btn-primary" onClick={() => ask()}><Icon name="send" size={14} />发送</button>}
          </div>
          <div className="ai-disclaimer" style={{ padding: '0 16px 12px' }}>AI 基于实时行情/RAG/联网新闻分析，仅供研究参考，非投资建议</div>
        </div>
      )}
    </>
  )
}

// 消息渲染（区分文本/诊断/扫描/复盘/选股）
const TOOL_LABEL = {
  search_stock: '搜索股票', get_quote: '查行情', get_stock_detail: '查主营',
  get_quant_score: '量化打分', screen_stocks: '选股筛选', get_sector_rank: '板块排行',
  get_limit_pool: '涨停池', get_movers: '盘中异动', get_market: '大盘情绪', web_news: '联网新闻',
}
function Message({ m }) {
  if (m.role === 'user') {
    return <div className="qa-msg user"><div className="qa-bubble"><div className="qa-bubble-text">{m.content}</div></div></div>
  }
  return (
    <div className="qa-msg assistant"><div className="qa-bubble">
      {m.kind === 'text' && (
        <>
          {Array.isArray(m.toolTrace) && m.toolTrace.length > 0 && (
            <div className="tool-trace">
              {m.toolTrace.map((t, i) => (
                <span key={i} className="tool-chip"><Icon name="bolt" size={11} /> {TOOL_LABEL[t.tool] || t.tool}</span>
              ))}
            </div>
          )}
          <div className="qa-bubble-text"><Md text={m.content} /></div>
          {Array.isArray(m.theoryRefs) && m.theoryRefs.length > 0 && (
            <div className="theory-refs">
              <span className="theory-refs-label"><Icon name="book" size={11} /> 参考理论</span>
              {m.theoryRefs.map((t, i) => (
                <span key={i} className="theory-chip" title={t.book + '·' + t.topic}>{t.book}·{t.topic}</span>
              ))}
            </div>
          )}
          {Array.isArray(m.news) && m.news.length > 0 && (
            <div className="qa-news">
              <div className="ai-label" style={{ marginTop: 2 }}>参考新闻（联网）</div>
              {m.news.slice(0, 3).map((n, j) => (
                <a key={j} className="qa-news-item" href={n.url} target="_blank" rel="noreferrer"><span className="qa-news-date">{n.date}</span>{n.title}</a>
              ))}
            </div>
          )}
        </>
      )}
      {m.kind === 'diagnose' && <Diagnose r={m.data} />}
      {m.kind === 'scan' && <Scan r={m.data} />}
      {m.kind === 'market' && <MarketReview r={m.data} />}
      {m.kind === 'sector' && <SectorPick r={m.data} />}
    </div></div>
  )
}

function badge(s, up = '强', down = '弱') {
  if (!s) return 'neutral'
  if (s.includes(up) || s.includes('多')) return 'up'
  if (s.includes(down) || s.includes('空')) return 'down'
  return 'neutral'
}

function Diagnose({ r }) {
  return (
    <div className="ai-result">
      {r.reasoning && <div className="ai-reasoning"><span className="ai-reasoning-k">研判</span>{r.reasoning}</div>}
      <div className="ai-senti"><span className={'ai-badge ' + badge(r.strength)}>{r.strength || '—'}</span><span className="ai-summary">{r.view}</span></div>
      {Array.isArray(r.points) && <div className="ai-block">{r.points.map((p, i) => <div key={i} className="ai-line">· {p}</div>)}</div>}
      {r.watch && <div className="ai-line" style={{ marginTop: 6 }}><span className="ai-tag-watch">关注</span>{r.watch}</div>}
    </div>
  )
}
function Scan({ r }) {
  return (
    <div className="ai-result">
      {r.reasoning && <div className="ai-reasoning"><span className="ai-reasoning-k">研判</span>{r.reasoning}</div>}
      {r.marketMood && <div className="ai-summary" style={{ marginBottom: 8 }}>{r.marketMood}</div>}
      {Array.isArray(r.topDirections) && r.topDirections.map((d, i) => (
        <div key={i} className="ai-pick">
          <div className="ai-pick-head"><b>{d.rank || i + 1}. {d.direction}</b>{d.strength && <span className={'dir-strength ' + d.strength}>{d.strength}</span>}</div>
          <div className="ai-line">{d.logic}</div>
          {Array.isArray(d.representStocks) && d.representStocks.length > 0 && (
            <div className="dir-stocks" style={{ marginTop: 4 }}>
              {d.representStocks.map((s, j) => <span key={j} className="dir-stock" onClick={() => s.code && openStockDetail(s.code, s.name)} style={{ cursor: 'pointer' }}>{s.name} {s.code}</span>)}
            </div>
          )}
        </div>
      ))}
      {r.strategy && <div className="ai-line" style={{ marginTop: 8 }}><span className="ai-tag-reason">策略</span>{r.strategy}</div>}
      {r.topRisk && <div className="ai-line"><span className="ai-tag-watch">风险</span>{r.topRisk}</div>}
    </div>
  )
}
function MarketReview({ r }) {
  return (
    <div className="ai-result">
      {r.reasoning && <div className="ai-reasoning"><span className="ai-reasoning-k">研判</span>{r.reasoning}</div>}
      <div className="ai-senti"><span className={'ai-badge ' + badge(r.sentiment)}>{r.sentiment || '—'}</span>{typeof r.score === 'number' && <span className="ai-score">情绪分 <b>{r.score}</b></span>}<span className="ai-summary">{r.summary}</span></div>
      {Array.isArray(r.mainLines) && <div className="ai-block"><div className="ai-label">最强主线</div>{r.mainLines.map((x, i) => <div key={i} className="ai-line"><b>{x.name}</b> — {x.reason}</div>)}</div>}
      {Array.isArray(r.risks) && <div className="ai-block"><div className="ai-label">风险</div>{r.risks.map((x, i) => <div key={i} className="ai-line">· {x}</div>)}</div>}
      {r.advice && <div className="ai-line" style={{ marginTop: 6 }}><span className="ai-tag-reason">建议</span>{r.advice}</div>}
    </div>
  )
}
function SectorPick({ r }) {
  return (
    <div className="ai-result">
      {r.reasoning && <div className="ai-reasoning"><span className="ai-reasoning-k">研判</span>{r.reasoning}</div>}
      {r.sectorView && <div className="ai-summary" style={{ marginBottom: 8 }}>{r.sectorView}</div>}
      {Array.isArray(r.picks) && r.picks.map((p, i) => (
        <div key={i} className="ai-pick">
          <div className="ai-pick-head"><b>{p.name}</b> <span className="dir-stock" onClick={() => p.code && openStockDetail(p.code, p.name)} style={{ cursor: 'pointer' }}>{p.code}</span></div>
          <div className="ai-line"><span className="ai-tag-reason">逻辑</span>{p.reason}</div>
          <div className="ai-line"><span className="ai-tag-watch">关注</span>{p.watch}</div>
        </div>
      ))}
      {r.note && <div className="ai-line" style={{ marginTop: 6 }}>{r.note}</div>}
    </div>
  )
}
