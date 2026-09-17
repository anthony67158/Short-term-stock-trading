import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Icon from './Icon'
import ErrorBoundary from './ErrorBoundary'
import StockPickAgentPanel from './StockPickAgentPanel'
import StockPickCandidatePool from './StockPickCandidatePool'
import StockPickRunTrace from './StockPickRunTrace'
import { usePolling } from '../hooks'
import {
  loadStockPick,
  recalculateNextDayStocks,
  runStockPickAgent,
  runStockPickRecall,
  saveNextDayStockSelection,
} from '../stockPickClient'
import {
  STOCK_PICK_MODE,
  STOCK_PICK_MODES,
  firstQuoteRecalculationCodes,
  stockPickModeMeta,
} from '../../shared/stockPickModes.js'

function topReferences(snapshot) {
  return (snapshot?.candidates || []).slice(0, 3).map((item) => ({
    code: item.code,
    name: item.name,
    rankingSource: item.ranking?.source || 'RULE',
    rankingScore: item.ranking?.score,
    recallReasons: item.recallReasons || [],
  }))
}

export default function StockPickTab() {
  const [activeMode, setActiveMode] = useState(STOCK_PICK_MODE.INTRADAY)
  const [state, setState] = useState({
    snapshot: null,
    agents: {},
    agentProgress: {},
    nextDaySelection: null,
    progress: null,
  })
  const [selectedCodes, setSelectedCodes] = useState([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const autoAttemptRef = useRef('')

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    try {
      const payload = await loadStockPick()
      setState({
        snapshot: payload.snapshot || null,
        agents: payload.agents || {
          [STOCK_PICK_MODE.INTRADAY]: payload.agent || null,
        },
        agentProgress: payload.agentProgress || {},
        nextDaySelection: payload.nextDaySelection || null,
        progress: payload.progress || null,
      })
      if (!quiet) setError('')
    } catch (cause) {
      if (!quiet) setError(String(cause?.message || cause))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!busy) return undefined
    const timer = setInterval(() => {
      void refresh({ quiet: true })
    }, 900)
    return () => clearInterval(timer)
  }, [busy, refresh])

  const selectionStamp = state.nextDaySelection?.savedAt || 0
  useEffect(() => {
    setSelectedCodes(
      (state.nextDaySelection?.items || []).map((item) => item.code),
    )
  }, [selectionStamp])

  const watchedCodes = useMemo(
    () => (state.nextDaySelection?.items || []).map((item) => item.code),
    [state.nextDaySelection],
  )
  const watchedKey = watchedCodes.join(',')
  const watchedQuotes = usePolling(
    watchedCodes.length ? `/api/quote?codes=${watchedKey}` : null,
    watchedCodes.length ? 10_000 : 0,
    [watchedKey],
  )

  useEffect(() => {
    const codes = firstQuoteRecalculationCodes(
      state.nextDaySelection,
      watchedQuotes.data?.list || [],
    )
    if (!codes.length || busy) return
    const tradeDate = (watchedQuotes.data?.list || [])
      .find((item) => codes.includes(item.code))?.tradeDate || ''
    const attemptKey = `${tradeDate}:${codes.join(',')}`
    if (!tradeDate || autoAttemptRef.current === attemptKey) return
    autoAttemptRef.current = attemptKey
    setBusy('next-day-auto')
    setError('')
    setNotice('检测到次日首笔有效报价，正在自动复算人工关注名单')
    void recalculateNextDayStocks(codes, 'FIRST_QUOTE')
      .then(() => refresh())
      .catch((cause) => setError(String(cause?.message || cause)))
      .finally(() => setBusy(''))
  }, [
    busy,
    refresh,
    state.nextDaySelection,
    watchedQuotes.data,
  ])

  const runRecall = async () => {
    if (busy) return
    setBusy('recall')
    setError('')
    setNotice('')
    try {
      await runStockPickRecall()
      await refresh()
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy('')
    }
  }

  const runAgent = async () => {
    if (busy) return
    setBusy(`agent:${activeMode}`)
    setError('')
    setNotice('')
    try {
      await runStockPickAgent(activeMode)
      await refresh()
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy('')
    }
  }

  const toggleSelected = (code) => {
    setSelectedCodes((current) => {
      if (current.includes(code)) {
        return current.filter((item) => item !== code)
      }
      if (current.length >= 12) return current
      return [...current, code]
    })
  }

  const saveSelection = async () => {
    if (busy) return
    setBusy('save-next-day')
    setError('')
    setNotice('')
    try {
      const payload = await saveNextDayStockSelection(selectedCodes)
      setState((current) => ({
        ...current,
        nextDaySelection: payload.nextDaySelection || null,
      }))
      setNotice(
        selectedCodes.length
          ? `已保存 ${selectedCodes.length} 只次日自动复算股票`
          : '已清空次日自动复算名单',
      )
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy('')
    }
  }

  const recalculateSelected = async () => {
    if (busy || !selectedCodes.length) return
    setBusy('next-day-manual')
    setError('')
    setNotice('正在保存人工名单并按最新行情重新测算')
    try {
      await saveNextDayStockSelection(selectedCodes)
      await recalculateNextDayStocks(selectedCodes, 'MANUAL_RECHECK')
      await refresh()
      setNotice('已按最新行情完成次日关注复算')
    } catch (cause) {
      setError(String(cause?.message || cause))
    } finally {
      setBusy('')
    }
  }

  const { snapshot, agents, agentProgress } = state
  const activeAgent = agents?.[activeMode] || null
  const activeTrace = agentProgress?.[activeMode] || null
  const modeMeta = stockPickModeMeta(activeMode)
  const references = (
    activeAgent
    && !(activeAgent.conclusion === 'SELECT' && activeAgent.selections?.length)
  ) ? topReferences(snapshot) : []
  const agentBusy = busy === `agent:${activeMode}`
    || (activeMode === STOCK_PICK_MODE.NEXT_DAY
      && ['next-day-manual', 'next-day-auto'].includes(busy))

  return (
    <div className="stock-pick">
      <StockPickHeader
        snapshot={snapshot}
        progress={state.progress}
        busy={busy}
        onRecall={runRecall}
      />
      <ModeNavigation
        activeMode={activeMode}
        onChange={setActiveMode}
        busy={busy}
        onRun={runAgent}
      />
      {activeMode === STOCK_PICK_MODE.NEXT_DAY && (
        <NextDayControls
          selectedCount={selectedCodes.length}
          saved={state.nextDaySelection}
          busy={busy}
          onSave={saveSelection}
          onRecalculate={recalculateSelected}
        />
      )}
      {error && (
        <div className="stock-pick-error" role="alert">{error}</div>
      )}
      {notice && !error && (
        <div className="stock-pick-notice" role="status">{notice}</div>
      )}
      <StockPickRunTrace trace={activeTrace} active={agentBusy} />
      <ErrorBoundary label={`${modeMeta.label}结果`}>
        <StockPickAgentPanel
          selection={activeAgent}
          references={references}
          modeLabel={modeMeta.label}
        />
      </ErrorBoundary>
      <ErrorBoundary label="模型候选池">
        <StockPickCandidatePool
          snapshot={snapshot}
          selectable={activeMode === STOCK_PICK_MODE.NEXT_DAY}
          selectedCodes={selectedCodes}
          onToggle={toggleSelected}
        />
      </ErrorBoundary>
    </div>
  )
}

function StockPickHeader({ snapshot, progress, busy, onRecall }) {
  const universe = snapshot?.universe || {}
  const sourceLabel = snapshot?.rankingSource === 'MODEL'
    ? '真实模型排序'
    : '规则召回排序'
  return (
    <section className="panel stock-pick-head" aria-label="全市场选股">
      <div className="stock-pick-head-main">
        <div className="panel-title">
          <Icon name="radar" size={16} /> 全市场候选基线
        </div>
        <p>
          {snapshot
            ? `扫描 ${universe.inspected || universe.total || 0} 只 · 保留 ${snapshot.candidates?.length || 0} 只 · ${sourceLabel}`
            : '先扫描全市场，再按场景调用选股 Agent'}
        </p>
        {busy === 'recall' && progress?.message && (
          <small>{progress.message}</small>
        )}
      </div>
      <button
        type="button"
        className="btn"
        onClick={onRecall}
        disabled={!!busy}
        aria-busy={busy === 'recall'}
      >
        <Icon
          name={busy === 'recall' ? 'refresh' : 'search'}
          size={14}
          className={busy === 'recall' ? 'spin' : ''}
        />
        {busy === 'recall' ? '扫描中' : '重新扫描'}
      </button>
    </section>
  )
}

function ModeNavigation({ activeMode, onChange, busy, onRun }) {
  const active = stockPickModeMeta(activeMode)
  return (
    <section className="stock-pick-mode-shell" aria-label="选股场景">
      <div className="stock-pick-mode-tabs" role="tablist" aria-label="选股模式">
        {STOCK_PICK_MODES.map((mode) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === mode.id}
            className={activeMode === mode.id ? 'active' : ''}
            key={mode.id}
            onClick={() => onChange(mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <div className="stock-pick-mode-action">
        <div>
          <strong>{active.label}</strong>
          <p>{active.description}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!!busy}
          onClick={onRun}
          aria-busy={busy === `agent:${activeMode}`}
        >
          <Icon
            name={busy === `agent:${activeMode}` ? 'refresh' : 'spark'}
            size={14}
            className={busy === `agent:${activeMode}` ? 'spin' : ''}
          />
          {busy === `agent:${activeMode}` ? '研判中' : `运行${active.label}`}
        </button>
      </div>
    </section>
  )
}

function NextDayControls({
  selectedCount,
  saved,
  busy,
  onSave,
  onRecalculate,
}) {
  const savedCount = saved?.items?.length || 0
  return (
    <section className="stock-pick-next-day" aria-label="次日复算设置">
      <div className="stock-pick-next-day-copy">
        <Icon name="clock" size={15} />
        <div>
          <strong>人工关注名单</strong>
          <p>
            已保存 {savedCount} 只。仅这些股票会在下一交易日首笔有效报价后自动复算。
          </p>
        </div>
      </div>
      <div className="stock-pick-next-day-actions">
        <button
          type="button"
          className="btn"
          disabled={!!busy}
          onClick={onSave}
        >
          <Icon name="check" size={14} />
          保存名单
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!!busy || !selectedCount}
          onClick={onRecalculate}
          aria-busy={busy === 'next-day-manual'}
        >
          <Icon
            name={busy === 'next-day-manual' ? 'refresh' : 'bolt'}
            size={14}
            className={busy === 'next-day-manual' ? 'spin' : ''}
          />
          {busy === 'next-day-manual' ? '复算中' : `重新测算 (${selectedCount})`}
        </button>
      </div>
    </section>
  )
}
