import { useState, useRef, useEffect } from 'react'
import { useAIStore, aiStore } from '../aiStore'
import { chatStore } from '../chatStore'
import { api } from '../apiBase'
import { accountRequestHeaders } from '../quantModel'
import { computePortfolio, livePositionOf, planStore, t1StatusOf, usePlanStore } from '../planStore'
import {
  formatEvidenceTime,
  sanitizeAccountContext,
} from '../../shared/assistantContext.js'
import { humanizeAdviceTextFields } from '../../shared/userFacingLanguage.js'
import { sanitizeTradeProposal } from '../../shared/tradeProposal.js'
import { useAiSearchConfig } from '../aiSearchConfigStore'
import Icon from './Icon'
import Md from './Md'
import Reasoning from './Reasoning'
import ConfirmDialog from './ConfirmDialog'
import StockName from './StockName'
import StockTags from './StockTags'

// ============ 统一 AI 助手：一个入口，对话为核心 ============
// 能力：个股多轮问答(RAG+新闻) + 快捷指令(全盘扫描/盘面复盘/板块选股/个股诊断)
// 对话按日期持久化，单日上下文连贯，可按天查看/删除历史

function buildAccountContext(book, snapshot) {
  const shared = typeof snapshot === 'function' ? (snapshot() || {}) : {}
  const quotes = Array.isArray(shared.quotes) ? shared.quotes : []
  const quoteMap = Object.fromEntries(quotes.filter((item) => item && item.code).map((item) => [item.code, item]))
  const portfolio = computePortfolio(book.holding || [], quoteMap, book.account)
  const weights = {}
  for (const item of (portfolio.positions || [])) weights[item.code] = (weights[item.code] || 0) + (Number(item.weight) || 0)
  const codes = [...new Set((book.holding || []).map((item) => item.code).filter(Boolean))]
  const positions = codes.map((code) => {
    const holding = (book.holding || []).find((item) => item.code === code) || {}
    const live = livePositionOf(code)
    const t1 = t1StatusOf(code)
    const quote = quoteMap[code] || {}
    const currentPrice = Number(quote.price) > 0 ? Number(quote.price) : null
    const pnlPct = currentPrice != null && live?.cost ? +((currentPrice - live.cost) / live.cost * 100).toFixed(2) : null
    return {
      code, name: holding.name, qty: live?.qty, cost: live?.cost,
      currentPrice, pnlPct, sellableToday: t1.sellableToday,
      t1Locked: t1.boughtToday > 0, weightPct: +(weights[code] || 0).toFixed(1),
      tp: holding.tp, sl: holding.sl,
    }
  })
  const recentTrades = [...(book.closed || [])]
    .sort((a, b) => (b.at || b.sellAt || b.buyAt || 0) - (a.at || a.sellAt || a.buyAt || 0))
    .slice(0, 10)
    .map((item) => ({ ...item, type: item.type || item.kind }))
  return sanitizeAccountContext({
    capturedAt: Date.now(),
    counts: {
      positions: positions.length,
      watchlist: (book.plan || []).length,
      recentTrades: (book.closed || []).length,
    },
    account: {
      totalAssets: portfolio.totalAssets,
      cash: portfolio.available,
      positionPct: portfolio.position,
    },
    positions,
    watchlist: (book.plan || []).map((item) => ({
      code: item.code, name: item.name, qScore: item.qScore, qBias: item.qBias,
    })),
    recentTrades,
    decision: planStore.decisionStats(),
  })
}

function sanitizeProposals(items, evidence) {
  const allowed = (evidence || []).map((item) => item.id)
  return (Array.isArray(items) ? items : [])
    .map((item) => sanitizeTradeProposal(item, allowed))
    .filter((item) => item && item.evidenceIds.length > 0)
    .slice(0, 5)
}

export default function AIAssistant({ snapshot }) {
  const { open, stock, sector, intent, seq, prefill, prefillSeq } = useAIStore()
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmProposal, setConfirmProposal] = useState(null)
  const [proposalNotice, setProposalNotice] = useState('')
  const book = usePlanStore()
  const searchConfig = useAiSearchConfig()
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

  // 命令入口（⌘K / Ctrl+K / /）打开后立即进入可输入状态。
  useEffect(() => {
    if (!open || loading) return undefined
    const timer = setTimeout(() => {
      try { inputRef.current?.focus({ preventScroll: true }) } catch { inputRef.current?.focus() }
    }, 0)
    return () => clearTimeout(timer)
  }, [open, loading])

  // 输入框随内容自动增高（多行预填/编辑时不遮挡）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [q, open])

  // 消息变化时，持久化到「当天」（仅当查看的是今天、且没有正在流式的消息时写入；
  // 流式过程中每 token 都写盘既浪费又会存下临时态，故等流式结束再落盘，并剥离临时字段）
  useEffect(() => {
    if (!isToday) return
    if (msgs.some((m) => m.streaming)) return
    const clean = msgs.map(({ streaming, status, steps, ...rest }) => rest)
    chatStore.save(clean, today)
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

  // ===== 核心：Agent 对话（SSE 流式：工具进度实时可见 + 答案逐字流出） =====
  const ask = async (question) => {
    const query = (question || q).trim()
    if (!query || loading) return
    setQ('')
    let base = msgs
    if (!isToday) { base = chatStore.load(today); setDay(today); setMsgs(base) }
    const history = base
      .filter((m) =>
        m.kind === 'text'
        && (searchConfig.enabled || !m.searchReference)
      )
      .map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '',
      }))
      .slice(-12)
    pushUser(query)
    setLoading(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    // 先插入一个"流式中"的助手占位消息，后续所有事件都就地更新它
    let aiIndex = -1
    setMsgs((m) => { aiIndex = m.length; return [...m, { role: 'assistant', kind: 'text', content: '', steps: [], theoryRefs: [], evidence: [], actionProposals: [], streaming: true, status: '正在规划分析路径…' }] })
    // 就地更新占位消息的辅助函数
    const patchAI = (patch) => setMsgs((m) => {
      const idx = m.findIndex((x, i) => i >= 0 && x.role === 'assistant' && x.streaming)
      if (idx < 0) return m
      const next = m.slice()
      next[idx] = typeof patch === 'function' ? patch(next[idx]) : { ...next[idx], ...patch }
      return next
    })

    try {
      const accountContext = buildAccountContext(book, snapshot)
      const res = await fetch(api('/api/agent'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...accountRequestHeaders(),
        },
        body: JSON.stringify({ question: query, history, stock: stock || null, accountContext }),
        signal: ctrl.signal,
      })
      const ctype = res.headers.get('content-type') || ''
      // 兜底：若后端未走 SSE(旧版/错误页) → 回退到整段解析
      if (!ctype.includes('text/event-stream')) {
        const raw = await res.text()
        let j = null; try { j = JSON.parse(raw) } catch { /* 非 JSON */ }
        if (j && j.ok) {
          const evidence = j.evidence || []
          patchAI({ content: j.answer || '', toolTrace: j.toolTrace || [], theoryRefs: j.theoryRefs || [], evidence, searchReference: j.searchReference || null, actionProposals: sanitizeProposals(j.actionProposals, evidence), streaming: false, status: null })
        }
        else patchAI({ content: '抱歉，' + ((j && j.error) || '分析超时，请换个更聚焦的问法重试。'), streaming: false, status: null })
      } else {
        // 解析 SSE：event: xxx\n data: {...}\n\n
        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buf = ''
        const handle = (event, data) => {
          if (event === 'status') patchAI({ status: data.text || '' })
          else if (event === 'theory') patchAI({ theoryRefs: data.theoryRefs || [] })
          else if (event === 'evidence') {
            patchAI((prev) => {
              const byId = new Map((prev.evidence || []).map((item) => [item.id, item]))
              for (const item of (data.evidence || [])) if (item && item.id) byId.set(item.id, item)
              return { ...prev, evidence: [...byId.values()] }
            })
          }
          else if (event === 'tool') {
            patchAI((prev) => {
              const steps = (prev.steps || []).slice()
              if (data.status === 'calling') {
                steps.push({ tool: data.tool, label: data.label, status: 'calling' })
              } else {
                // 把最近一个同名 calling 标记为 done/error
                for (let i = steps.length - 1; i >= 0; i--) {
                  if (steps[i].tool === data.tool && steps[i].status === 'calling') { steps[i] = { ...steps[i], status: data.status, brief: data.brief, error: data.error }; break }
                }
              }
              return { ...prev, steps, status: data.status === 'calling' ? `正在${data.label}…` : prev.status }
            })
          } else if (event === 'delta') {
            patchAI((prev) => ({ ...prev, content: (prev.content || '') + (data.text || ''), status: null }))
          } else if (event === 'done') {
            patchAI((prev) => {
              const evidence = data.evidence || prev.evidence || []
              return { ...prev, content: data.answer || prev.content, toolTrace: data.toolTrace || [], theoryRefs: data.theoryRefs || prev.theoryRefs, evidence, searchReference: data.searchReference || null, actionProposals: sanitizeProposals(data.actionProposals, evidence), streaming: false, status: null }
            })
          } else if (event === 'error') {
            patchAI((prev) => ({ ...prev, content: prev.content || ('抱歉，' + (data.error || '分析失败')), streaming: false, status: null }))
          }
        }
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let sep
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, sep); buf = buf.slice(sep + 2)
            let event = 'message', dataStr = ''
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
            }
            if (!dataStr) continue
            let data = null; try { data = JSON.parse(dataStr) } catch { continue }
            handle(event, data)
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') patchAI((prev) => ({ ...prev, content: prev.content || '已停止本次分析。', streaming: false, status: null }))
      else patchAI((prev) => ({ ...prev, content: prev.content || ('抱歉，网络异常：' + String(e.message || e)), streaming: false, status: null }))
    }
    finally {
      setLoading(false); abortRef.current = null
      // 流式结束确保清掉 streaming 标记
      setMsgs((m) => m.map((x) => (x.streaming ? { ...x, streaming: false, status: null } : x)))
    }
  }

  // 停止正在进行的分析
  const stop = () => { if (abortRef.current) abortRef.current.abort() }
  const appliedProposalIds = new Set((book.decisionLog || [])
    .filter((event) => event && event.kind === 'plan' && event.proposalId)
    .map((event) => event.proposalId))
  const requestApplyProposal = (proposal, evidence) => {
    const clean = sanitizeProposals([proposal], evidence)[0]
    if (!clean) { setProposalNotice('提案字段或证据校验失败，未打开确认'); return }
    setConfirmProposal(clean)
  }
  const confirmApplyProposal = () => {
    if (!confirmProposal) return
    const result = planStore.applyAssistantProposal(confirmProposal)
    setConfirmProposal(null)
    setProposalNotice(result && result.ok
      ? (result.alreadyApplied ? '该提案已写入计划，无需重复操作' : '已写入交易计划与预警，未记录成交')
      : ((result && result.error) || '提案写入失败'))
    setTimeout(() => setProposalNotice(''), 3200)
  }

  return (
    <>
      {/* 悬浮球 */}
      <button type="button" className={'ai-fab' + (open ? ' hidden' : '')} onClick={() => aiStore.open()} title="问军师" aria-label="问军师">
        <span className="ai-fab-spark"><Icon name="spark" size={18} /></span>
        <span className="ai-fab-text">军师</span>
      </button>

      {/* 抽屉 */}
      {open && (
        <div className="ai-drawer">
          <div className="ai-drawer-head">
            <div className="ai-drawer-title">
              <span className="ai-drawer-heading"><Icon name="spark" size={16} /> 军师 · 操盘问答</span>
              <span className="ai-focus muted">{isToday ? '直接提问，我会自己查数据' : `查看 ${day} 的对话（只读）`}</span>
            </div>
            <div className="ai-head-actions">
              <button className="icon-btn" title="历史对话" onClick={() => setHistOpen((v) => !v)}><Icon name="history" size={14} /></button>
              {msgs.length > 0 && isToday && <button className="icon-btn" title="清空今天对话" onClick={() => { if (confirm('清空今天的对话？')) { setMsgs([]); chatStore.removeDay(today) } }}><Icon name="trash" size={14} /></button>}
              <button type="button" className="modal-close" aria-label="关闭军师" onClick={() => aiStore.close()}><Icon name="close" size={16} /></button>
            </div>
          </div>

          {/* 历史对话面板（按天） */}
          {histOpen && (
            <div className="ai-hist">
              <div className="ai-hist-head">历史对话（按天）{!isToday && <button type="button" className="ai-hist-back" onClick={() => viewDay(today)}>回到今天</button>}</div>
              {chatStore.days().length === 0 && <div className="ai-hist-empty">暂无历史对话</div>}
              {chatStore.days().map((d) => {
                const s = chatStore.summary(d)
                return (
                  <div key={d} className={'ai-hist-item' + (d === day ? ' active' : '')}>
                    <button type="button" className="ai-hist-main" onClick={() => viewDay(d)}>
                      <b>{d === today ? '今天' : d}</b>
                      <span className="ai-hist-sub">{s.count}条 · {s.first}</span>
                    </button>
                    <button type="button" className="del" title="删除这一天" aria-label={`删除 ${d} 的对话`} onClick={() => {
                      if (confirm(`删除 ${d} 的全部对话？`)) {
                        chatStore.removeDay(d)
                        if (d === day) { const t = today; setDay(t); setMsgs(chatStore.load(t)) }
                        setHistTick((n) => n + 1)
                      }
                    }}>×</button>
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
                <div className="ai-welcome-title">我是你的短线操盘军师</div>
                <div className="ai-welcome-sub">直接跟我说话就行——想分析哪只票就说名字（如"分析寒武纪"），想选股、看板块、问大盘都可以，我会自己查数据回答。</div>
                <div className="qa-presets qa-presets-welcome">
                  <button type="button" className="qa-preset" onClick={() => ask('分析一下寒武纪，资金面、基本面、消息面都看看')}>分析寒武纪</button>
                  <button type="button" className="qa-preset" onClick={() => ask('帮我筛选涨幅5%以内、量比大于2、主力净流入靠前的票')}>按条件选股</button>
                  <button type="button" className="qa-preset" onClick={() => ask('半导体板块现在资金和情绪怎么样？值得关注吗')}>问某个板块</button>
                  <button type="button" className="qa-preset" onClick={() => ask('今天有哪些连板龙头？梯队健康吗')}>看连板梯队</button>
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <Message
                key={i}
                m={m}
                canApply={isToday}
                appliedProposalIds={appliedProposalIds}
                onApplyProposal={requestApplyProposal}
              />
            ))}
          </div>

          {/* 提问输入 */}
          {proposalNotice && <div className="proposal-notice" role="status">{proposalNotice}</div>}
          <div className="ai-input-row">
            <textarea
              ref={inputRef}
              className="wl-input ai-textarea"
              rows={1}
              placeholder={isToday ? '分析股票、板块或大盘…' : '输入内容，回到今天继续对话'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
              disabled={loading}
            />
            {loading
              ? <button className="btn btn-danger" onClick={stop}><Icon name="close" size={14} />停止</button>
              : <button className="btn btn-primary" onClick={() => ask()}><Icon name="send" size={14} />发送</button>}
          </div>
          <div className="ai-input-help">Enter 发送 · Shift+Enter 换行</div>
          <div className="ai-disclaimer ai-drawer-disclaimer">AI 基于实时行情/RAG/联网新闻分析，仅供研究参考，非投资建议</div>
        </div>
      )}
      {confirmProposal && (
        <ConfirmDialog
          title="确认写入交易计划与预警？"
          body={<ProposalConfirmBody proposal={confirmProposal} />}
          confirmText="确认写入"
          confirmIcon="target"
          danger={false}
          onConfirm={confirmApplyProposal}
          onCancel={() => setConfirmProposal(null)}
        />
      )}
    </>
  )
}

// 消息渲染（区分文本/诊断/扫描/复盘/选股）
const TOOL_LABEL = {
  search_stock: '搜索股票', get_quote: '查行情', get_stock_detail: '查主营',
  get_quant_score: '量化打分', screen_stocks: '选股筛选', get_sector_rank: '板块排行',
  get_limit_pool: '涨停池', get_movers: '盘中异动', get_market: '大盘情绪', web_news: '联网新闻',
  propose_trade_plan: '生成交易提案',
}
function Message({ m, canApply, appliedProposalIds, onApplyProposal }) {
  const searchConfig = useAiSearchConfig()
  const displayData = humanizeAdviceTextFields(m.data || {})
  const displayProposals = humanizeAdviceTextFields(
    m.actionProposals || [],
  )
  if (m.role === 'user') {
    return <div className="qa-msg user"><div className="qa-bubble"><div className="qa-bubble-text">{m.content}</div></div></div>
  }
  const visibleEvidence = (m.evidence || []).filter((item) =>
    searchConfig.enabled || item?.dimension !== 'search'
  )
  return (
    <div className="qa-msg assistant"><div className="qa-bubble">
      {m.kind === 'text' && (
        <>
          {/* 流式·工具调用进度：每一步实时显示 调用中→完成(带条数摘要)，让用户看到进展 */}
          {Array.isArray(m.steps) && m.steps.length > 0 && (
            <div className="tool-steps">
              {m.steps.map((s, i) => (
                <div key={i} className={'tool-step ' + s.status}>
                  <span className="ts-ico">
                    {s.status === 'calling' ? <Icon name="refresh" size={11} className="spin" /> : s.status === 'error' ? <Icon name="close" size={11} /> : <Icon name="check" size={11} />}
                  </span>
                  <span className="ts-label">{s.label || TOOL_LABEL[s.tool] || s.tool}</span>
                  {s.status === 'done' && s.brief && <span className="ts-brief">{s.brief}</span>}
                  {s.status === 'error' && <span className="ts-err">{s.error || '失败'}</span>}
                </div>
              ))}
            </div>
          )}
          {/* 流式·当前阶段状态(思考/写作)——答案还没开始流时显示 */}
          {m.streaming && m.status && !m.content && (
            <div className="ai-stream-status"><Icon name="spark" size={12} className="pulse" /> {m.status}</div>
          )}
          {/* 静态历史消息仍展示 toolTrace（无 steps 时）*/}
          {(!m.steps || m.steps.length === 0) && Array.isArray(m.toolTrace) && m.toolTrace.length > 0 && (
            <div className="tool-trace">
              {m.toolTrace.map((t, i) => (
                <span key={i} className="tool-chip"><Icon name="bolt" size={11} /> {TOOL_LABEL[t.tool] || t.tool}</span>
              ))}
            </div>
          )}
          {m.content && <div className="qa-bubble-text"><Md text={m.content} />{m.streaming && <span className="stream-caret" />}</div>}
          {displayProposals.length > 0 && (
            <ProposalList
              proposals={displayProposals}
              evidence={visibleEvidence}
              canApply={canApply}
              appliedProposalIds={appliedProposalIds}
              onApply={onApplyProposal}
            />
          )}
          {visibleEvidence.length > 0 && <EvidenceList evidence={visibleEvidence} />}
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
      {m.kind === 'diagnose' && <Diagnose r={displayData} />}
      {m.kind === 'scan' && <Scan r={displayData} />}
      {m.kind === 'market' && <MarketReview r={displayData} />}
      {m.kind === 'sector' && <SectorPick r={displayData} />}
    </div></div>
  )
}

const PROPOSAL_ACTION = {
  buy: { label: '买入计划', cls: 'buy' },
  add: { label: '加仓计划', cls: 'buy' },
  reduce: { label: '减仓计划', cls: 'sell' },
  sell: { label: '卖出计划', cls: 'sell' },
}

function ProposalList({ proposals, evidence, canApply, appliedProposalIds, onApply }) {
  return (
    <div className="proposal-list">
      <div className="proposal-head"><Icon name="target" size={12} /> 待确认交易提案</div>
      {proposals.map((proposal) => {
        const action = PROPOSAL_ACTION[proposal.action] || { label: proposal.action, cls: '' }
        const applied = appliedProposalIds.has(proposal.id)
        return (
          <div className="proposal-card" key={proposal.id}>
            <div className="proposal-card-head">
              <StockName code={proposal.code} name={proposal.name}>
                <span><b>{proposal.name}</b></span>
              </StockName>
              <span className={'proposal-action ' + action.cls}>{action.label}</span>
            </div>
            <div className="proposal-prices">
              <span>触发 <b>{proposal.triggerOp === 'lte' ? '≤' : '≥'} {proposal.entryPrice}</b></span>
              {proposal.targetPrice != null && <span>目标 <b>{proposal.targetPrice}</b></span>}
              {proposal.stopPrice != null && <span>止损 <b>{proposal.stopPrice}</b></span>}
              {proposal.qty != null && <span>计划 <b>{proposal.qty} 手</b></span>}
            </div>
            {proposal.reason && <div className="proposal-reason">{proposal.reason}</div>}
            {proposal.confirmSignal && <div className="proposal-confirm">到价后确认：{proposal.confirmSignal}</div>}
            {proposal.evidenceIds?.length > 0 && <div className="proposal-evidence">{proposal.evidenceIds.map((id) => `[${id}]`).join(' ')}</div>}
            <button
              type="button"
              className="chip-btn proposal-apply"
              disabled={!canApply || applied}
              onClick={() => onApply(proposal, evidence)}
            >
              <Icon name={applied ? 'check' : 'target'} size={12} />
              {applied ? '已写入计划' : canApply ? '转为计划与预警' : '历史提案只读'}
            </button>
          </div>
        )
      })}
      <div className="proposal-foot">写入后仅开始盯盘，不会记录为已成交。</div>
    </div>
  )
}

function ProposalConfirmBody({ proposal }) {
  const action = PROPOSAL_ACTION[proposal.action] || { label: proposal.action }
  return (
    <div className="proposal-dialog-body">
      <p>
        将 <b>{proposal.name}（{proposal.code}）</b>
        <StockTags code={proposal.code} variant="inline" />
        的“{action.label}”写入账号：
      </p>
      <div className="proposal-dialog-grid">
        <span>触发价</span><b>{proposal.triggerOp === 'lte' ? '≤' : '≥'} {proposal.entryPrice}</b>
        <span>计划手数</span><b>{proposal.qty != null ? `${proposal.qty} 手` : '未指定'}</b>
        <span>目标价</span><b>{proposal.targetPrice ?? '未指定'}</b>
        <span>止损价</span><b>{proposal.stopPrice ?? '未指定'}</b>
      </div>
      {proposal.confirmSignal && <p className="muted">到价后仍需确认：{proposal.confirmSignal}</p>}
      <p><b>不会执行真实下单，也不会记为已成交。</b></p>
    </div>
  )
}

function EvidenceList({ evidence }) {
  const dataEvidence = evidence.filter((item) => item?.dimension !== 'search')
  const searchEvidence = evidence.filter((item) => item?.dimension === 'search')
  const group = (title, icon, items, className = '') => items.length > 0 && (
    <div className={'evidence-list ' + className}>
      <div className="evidence-head"><Icon name={icon} size={12} /> {title}</div>
      {items.map((item) => {
        const body = (
          <>
            <span className="evidence-id">[{item.id}]</span>
            <span className="evidence-main">
              <span className="evidence-title">{item.title}</span>
              <span className="evidence-meta">{item.source} · {formatEvidenceTime(item.asOf, item.timeKind)}</span>
              {item.summary && <span className="evidence-summary">{item.summary}</span>}
            </span>
            {item.url && <Icon name="chevronRight" size={11} />}
          </>
        )
        return item.url
          ? <a className="evidence-item" key={item.id} href={item.url} target="_blank" rel="noreferrer">{body}</a>
          : <div className="evidence-item" key={item.id}>{body}</div>
      })}
    </div>
  )
  return (
    <>
      {group('数据证据', 'shield', dataEvidence)}
      {group('检索参考', 'search', searchEvidence, 'search-dimension')}
    </>
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
      {r.reasoning && <Reasoning text={r.reasoning} />}
      <div className="ai-senti"><span className={'ai-badge ' + badge(r.strength)}>{r.strength || '—'}</span><span className="ai-summary">{r.view}</span></div>
      {Array.isArray(r.points) && <div className="ai-block">{r.points.map((p, i) => <div key={i} className="ai-line">· {p}</div>)}</div>}
      {r.watch && <div className="ai-line" style={{ marginTop: 6 }}><span className="ai-tag-watch">关注</span>{r.watch}</div>}
    </div>
  )
}
function Scan({ r }) {
  return (
    <div className="ai-result">
      {r.reasoning && <Reasoning text={r.reasoning} />}
      {r.marketMood && <div className="ai-summary" style={{ marginBottom: 8 }}>{r.marketMood}</div>}
      {Array.isArray(r.topDirections) && r.topDirections.map((d, i) => (
        <div key={i} className="ai-pick">
          <div className="ai-pick-head"><b>{d.rank || i + 1}. {d.direction}</b>{d.strength && <span className={'dir-strength ' + d.strength}>{d.strength}</span>}</div>
          <div className="ai-line">{d.logic}</div>
          {Array.isArray(d.representStocks) && d.representStocks.length > 0 && (
            <div className="dir-stocks" style={{ marginTop: 4 }}>
              {d.representStocks.map((s, j) => (
                <StockName
                  key={j}
                  code={s.code}
                  name={s.name}
                  className="dir-stock"
                >
                  <span>{s.name}</span>
                </StockName>
              ))}
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
      {r.reasoning && <Reasoning text={r.reasoning} />}
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
      {r.reasoning && <Reasoning text={r.reasoning} />}
      {r.sectorView && <div className="ai-summary" style={{ marginBottom: 8 }}>{r.sectorView}</div>}
      {Array.isArray(r.picks) && r.picks.map((p, i) => (
        <div key={i} className="ai-pick">
          <div className="ai-pick-head">
            <StockName code={p.code} name={p.name}>
              <span><b>{p.name}</b></span>
            </StockName>
          </div>
          <div className="ai-line"><span className="ai-tag-reason">逻辑</span>{p.reason}</div>
          <div className="ai-line"><span className="ai-tag-watch">关注</span>{p.watch}</div>
        </div>
      ))}
      {r.note && <div className="ai-line" style={{ marginTop: 6 }}>{r.note}</div>}
    </div>
  )
}
