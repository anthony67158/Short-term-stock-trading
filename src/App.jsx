import { useState, useRef, useEffect } from 'react'
import Icon from './components/Icon'
import TodayTab from './components/TodayTab'
import PlanTab from './components/PlanTab'
import ReviewTab from './components/ReviewTab'
import ResearchTab from './components/ResearchTab'
import AIAssistant from './components/AIAssistant'
import StockDetail from './components/StockDetail'
import AuthGate, { AccountMenu } from './components/AuthGate'
import { usePolling, isTradingHours, useCountdown, triggerRefresh, useRefreshTick } from './hooks'
import { usePlanStore } from './planStore'
import { useAIStore } from './aiStore'
import { useAuthStore, authStore } from './authStore'
import { useDetailStore, detailStore } from './detailStore'
import { timeStr } from './format'

const TABS = [
  { key: 'today', label: '今日选股', icon: 'radar' },
  { key: 'plan', label: '持仓·做T', icon: 'wallet' },
  { key: 'review', label: '交易记录', icon: 'history' },
  { key: 'research', label: '盘面研究', icon: 'layers' },
]

export default function App() {
  const { user, booting } = useAuthStore()
  useEffect(() => { authStore.boot() }, [])   // 启动时尝试恢复会话
  if (booting) return (
    <div className="auth-gate"><div className="auth-card" style={{ textAlign: 'center' }}>
      <div className="auth-brand"><span className="nav-logo"><Icon name="pulse" size={20} /></span><span>短线操盘台</span></div>
      <div className="play-hint"><Icon name="refresh" size={14} className="spin" /> 正在恢复登录…</div>
    </div></div>
  )
  if (!user) return <AuthGate />   // 未登录 → 全屏登录/注册门户
  return <MainApp key={user} />    // key=user：切换账号时整树重挂
}

function MainApp() {
  const [tab, setTab] = useState('today')
  const { open: aiOpen } = useAIStore()
  const { stock: detailStock } = useDetailStore()
  const trading = isTradingHours()
  const interval = trading ? 20000 : 120000

  // 主流程共享数据（今日选股 / 复盘 / 助手 用）
  const market = usePolling('/api/market', interval)
  const sectors = usePolling('/api/sectors?type=industry&sort=main', interval)
  const ztPool = usePolling('/api/limitup?kind=zt', interval)
  const moversData = usePolling('/api/movers?kind=inflow', interval)

  const refreshTick = useRefreshTick()
  const remain = useCountdown(interval, (market.data && market.data.updatedAt) + refreshTick)
  const book = usePlanStore()
  const planCount = book.plan.length + book.holding.length

  // 数据快照给 AI（避免频繁重建）
  const dataRef = useRef({})
  dataRef.current = { market: market.data, sectors: sectors.data, limitPool: ztPool.data, movers: moversData.data }
  const snapshot = () => dataRef.current

  return (
    <div className={'app' + (aiOpen ? ' with-ai' : '')}>
      {/* 顶部导航 */}
      <header className="nav">
        <div className="nav-brand">
          <span className="nav-logo"><Icon name="pulse" size={18} /></span>
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
          <AccountMenu />
        </div>
      </header>

      <main className="main">
        {tab === 'today' && <TodayTab interval={interval} market={market.data} sectors={sectors.data} snapshot={snapshot} />}
        {tab === 'plan' && <PlanTab interval={interval} />}
        {tab === 'review' && <ReviewTab interval={interval} snapshot={snapshot} />}
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
