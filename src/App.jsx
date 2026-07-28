import { useState, useRef, useEffect } from 'react'
import Icon from './components/Icon'
import TodayTab from './components/TodayTab'
import PlanTab from './components/PlanTab'
import ResearchTab from './components/ResearchTab'
import AccountHub from './components/AccountHub'
import AIAssistant from './components/AIAssistant'
import StockDetail from './components/StockDetail'
import AuthGate, { AccountMenu } from './components/AuthGate'
import { usePolling, isTradingHours, useCountdown, triggerRefresh, useRefreshTick } from './hooks'
import { usePlanStore } from './planStore'
import { useAIStore } from './aiStore'
import { useAuthStore, authStore } from './authStore'
import { useTheme, themeStore } from './themeStore'
import { useDetailStore, detailStore } from './detailStore'
import { alertStore, useAlertStore } from './alertStore'
import { timeStr } from './format'

const TABS = [
  { key: 'today', label: '今日选股', icon: 'radar' },
  { key: 'plan', label: '持仓·做T', icon: 'wallet' },
  { key: 'hub', label: '账户·交易', icon: 'gauge' },
  { key: 'research', label: '盘面研究', icon: 'layers' },
]

export default function App() {
  const { user, booting } = useAuthStore()
  useEffect(() => { authStore.boot() }, [])   // 启动时尝试恢复会话
  if (booting) return (
    <div className="auth-gate"><div className="auth-card" style={{ textAlign: 'center' }}>
      <div className="auth-brand"><span className="nav-logo"><Icon name="logo" size={20} /></span><span>短线操盘台</span></div>
      <div className="play-hint"><Icon name="refresh" size={14} className="spin" /> 正在恢复登录…</div>
    </div></div>
  )
  if (!user) return <AuthGate />   // 未登录 → 全屏登录/注册门户
  return <MainApp key={user} />    // key=user：切换账号时整树重挂
}

function MainApp() {
  const [tab, setTab] = useState('today')
  const [hubSub, setHubSub] = useState('account') // 账户·交易 融合页的子页
  const [hubNonce, setHubNonce] = useState(0)      // 每次外部要求跳预警时自增，强制生效
  const { open: aiOpen } = useAIStore()
  const theme = useTheme()
  const { stock: detailStock } = useDetailStore()
  const trading = isTradingHours()
  const interval = trading ? 20000 : 120000

  // 主流程共享数据（今日选股 / 复盘 / 助手 用）
  const market = usePolling('/api/market', interval)
  const sectors = usePolling('/api/sectors?type=industry&sort=main', interval)
  const ztPool = usePolling('/api/board?type=limitup&kind=zt', interval)
  const moversData = usePolling('/api/board?type=movers&kind=inflow', interval)

  const refreshTick = useRefreshTick()
  const remain = useCountdown(interval, (market.data && market.data.updatedAt) + refreshTick)
  const book = usePlanStore()
  const planCount = book.plan.length + book.holding.length

  // ===== 盯盘预警：轮询所有“启用中预警”涉及的个股报价 → 逐条判断命中 =====
  const alertCodes = [...new Set((book.alerts || []).filter((a) => a.enabled).map((a) => a.code))]
  const alertInterval = trading ? 15000 : 60000
  const alertQuotes = usePolling(
    alertCodes.length ? `/api/quote?codes=${alertCodes.join(',')}` : null,
    alertInterval,
    [alertCodes.join(',')]
  )
  useEffect(() => {
    const list = (alertQuotes.data && alertQuotes.data.list) || []
    if (!list.length) return
    const map = {}
    list.forEach((q) => { map[q.code] = q })
    alertStore.evaluate(map)
  }, [alertQuotes.data])

  // 数据快照给 AI（避免频繁重建）
  const dataRef = useRef({})
  dataRef.current = { market: market.data, sectors: sectors.data, limitPool: ztPool.data, movers: moversData.data }
  const snapshot = () => dataRef.current

  return (
    <div className={'app' + (aiOpen ? ' with-ai' : '')}>
      {/* 顶部导航 */}
      <header className="nav">
        <div className="nav-brand">
          <span className="nav-logo"><Icon name="logo" size={18} /></span>
          <span className="nav-name">短线操盘台</span>
        </div>
        <nav className="nav-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={'nav-tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              <Icon name={t.icon} size={16} />
              <span>{t.label}</span>
              {t.key === 'plan' && planCount > 0 && <span className="nav-badge">{planCount}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-meta">
          <span className={'nav-status ' + (trading ? 'on' : 'off')}>
            <span className="status-dot" />{trading ? '交易中' : '休市'}
          </span>
          <button className="nav-refresh" onClick={triggerRefresh} title="立即刷新数据">
            <Icon name="refresh" size={13} /><span>{remain}s</span>
          </button>
          <AlertBell onOpen={() => { setHubSub('alert'); setHubNonce((n) => n + 1); setTab('hub') }} />
          <button className="icon-btn nav-theme" onClick={themeStore.toggle} title={theme === 'dark' ? '切到白天模式' : '切到夜间模式'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
          </button>
          <AccountMenu />
        </div>
      </header>

      <main className="main">
        {tab === 'today' && <TodayTab interval={interval} market={market.data} sectors={sectors.data} snapshot={snapshot} />}
        {tab === 'plan' && <PlanTab interval={interval} />}
        {tab === 'hub' && <AccountHub interval={interval} snapshot={snapshot} initialSub={hubSub} jumpNonce={hubNonce} />}
        {tab === 'research' && <ResearchTab interval={interval} />}
      </main>

      <footer className="footer">
        数据来源：东方财富公开接口 · AI 分析由大模型基于实时数据生成，仅供研究参考，非投资建议 · 资金流为已发生数据，追高有滞后风险，注意止损
      </footer>

      <AIAssistant snapshot={snapshot} />

      {/* 全局个股详情弹窗：任意页面点击股票名都会打开 */}
      {detailStock && <StockDetail stock={detailStock} onClose={() => detailStore.close()} />}
    </div>
  )
}

// 导航栏预警铃铛：显示未读数，点击跳到「账户·交易 → 盯盘预警」子页
function AlertBell({ onOpen }) {
  const { unread } = useAlertStore()
  return (
    <button className="icon-btn nav-bell" onClick={onOpen} title="盯盘预警">
      <Icon name="bell" size={15} />
      {unread > 0 && <span className="nav-bell-dot">{unread > 9 ? '9+' : unread}</span>}
    </button>
  )
}
