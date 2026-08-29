import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isContinuousTrading,
} from '../../shared/tradingCalendar.js'
import {
  loadFormulaSelectionProgress,
  loadFormulaSelectionState,
  runFormulaSelection,
} from '../formulaSelectionClient.js'
import { planStore, usePlanStore } from '../planStore.js'
import Icon from './Icon'
import TailPick from './TailPick'
import FormulaSelectionCandidate, {
  displayFormulaPrice,
  FORMULA_NAMES,
  PRICE_LABELS,
} from './FormulaSelectionCandidate'
import FormulaSelectionProgress from './FormulaSelectionProgress'

const MODES = [
  { id: 'intraday', label: '盘中机会' },
  { id: 'close', label: '次日关注' },
  { id: 'tail', label: '尾盘反转' },
]

export default function FormulaSelection() {
  const [mode, setMode] = useState(
    () => isContinuousTrading(Date.now()) ? 'intraday' : 'close',
  )
  const [state, setState] = useState({
    loading: true,
    error: '',
    intraday: null,
    close: null,
    progress: {
      intraday: null,
      close: null,
    },
  })
  const [activeRunMode, setActiveRunMode] = useState('')
  const activeRunStartedAt = useRef(0)
  const book = usePlanStore()

  useEffect(() => {
    let active = true
    loadFormulaSelectionState()
      .then((payload) => {
        if (!active) return
        setState({
          loading: false,
          error: '',
          intraday: payload.intraday || null,
          close: payload.close || null,
          progress: payload.progress || {
            intraday: null,
            close: null,
          },
        })
        const runningMode = ['intraday', 'close'].find(
          (item) => payload.progress?.[item]?.status === 'RUNNING',
        )
        if (runningMode) {
          activeRunStartedAt.current =
            Number(payload.progress?.[runningMode]?.startedAt) || 0
          setActiveRunMode(runningMode)
        }
      })
      .catch((error) => {
        if (!active) return
        setState((current) => ({
          ...current,
          loading: false,
          error: String(error?.message || error),
        }))
      })
    return () => { active = false }
  }, [])

  const result = mode === 'tail' ? null : state[mode]
  const candidates = result?.candidates || []
  const running = Boolean(activeRunMode)
  const activeTask = activeRunMode
    ? state.progress?.[activeRunMode]
    : null
  const currentTask = mode === activeRunMode ? activeTask : null
  const canRun = mode === 'close' || isContinuousTrading(Date.now())
  const formulaSummary = useMemo(
    () => (result?.formulas || [])
      .map((item) => `${item.name}${item.candidateCount}`)
      .join(' · '),
    [result],
  )

  useEffect(() => {
    if (!activeRunMode) return undefined
    let active = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const payload = await loadFormulaSelectionProgress(activeRunMode)
        if (!active) return
        const task = payload.task || null
        if (
          task
          && activeRunStartedAt.current
          && Number(task.startedAt || 0)
            < activeRunStartedAt.current - 5000
        ) return
        setState((current) => ({
          ...current,
          progress: {
            ...current.progress,
            [activeRunMode]: task,
          },
        }))
        if (task?.status === 'DONE') {
          const latest = await loadFormulaSelectionState()
          if (!active) return
          setState((current) => ({
            ...current,
            error: '',
            intraday: latest.intraday || current.intraday,
            close: latest.close || current.close,
            progress: latest.progress || current.progress,
          }))
          activeRunStartedAt.current = 0
          setActiveRunMode('')
        } else if (task?.status === 'FAILED') {
          setState((current) => ({
            ...current,
            error: task.error || task.message || '公式计算失败',
          }))
          activeRunStartedAt.current = 0
          setActiveRunMode('')
        }
      } catch {
        // The original generation request remains authoritative.
      } finally {
        polling = false
      }
    }
    const timer = setInterval(poll, 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [activeRunMode])

  const run = async () => {
    if (running || mode === 'tail' || !canRun) return
    const runMode = mode
    let keepPolling = false
    activeRunStartedAt.current = Date.now()
    setActiveRunMode(runMode)
    setState((current) => ({
      ...current,
      error: '',
      progress: {
        ...current.progress,
        [runMode]: {
          status: 'RUNNING',
          stage: 'MARKET_GATE',
          percent: 3,
          message: '正在启动公式计算',
        },
      },
    }))
    try {
      const payload = await runFormulaSelection(runMode)
      if (payload.running) {
        keepPolling = true
        activeRunStartedAt.current =
          Number(payload.task?.startedAt) || activeRunStartedAt.current
        setState((current) => ({
          ...current,
          progress: {
            ...current.progress,
            [runMode]: payload.task || current.progress?.[runMode],
          },
        }))
        return
      }
      setState((current) => ({
        ...current,
        [runMode]: payload,
        progress: {
          ...current.progress,
          [runMode]: {
            ...current.progress?.[runMode],
            status: 'DONE',
            stage: 'DONE',
            percent: 100,
          },
        },
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        error: String(error?.message || error),
      }))
    } finally {
      if (!keepPolling) {
        activeRunStartedAt.current = 0
        setActiveRunMode('')
      }
    }
  }

  const add = (candidate) => {
    planStore.addPlan(
      { code: candidate.code, name: candidate.name },
      `公式选股观察：${FORMULA_NAMES[candidate.formulaId] || ''}；`
        + `${PRICE_LABELS[candidate.priceType] || '观察价'}`
        + `${displayFormulaPrice(candidate.primaryPrice)}`,
    )
  }

  const tabs = (
    <div
      className="formula-selection-tabs"
      role="tablist"
      aria-label="公式选股视图"
    >
      {MODES.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={mode === item.id}
          className={mode === item.id ? 'active' : ''}
          key={item.id}
          onClick={() => setMode(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )

  if (mode === 'tail') {
    return (
      <TailPick
        title="公式选股"
        navigation={tabs}
      />
    )
  }

  return (
    <section className="panel formula-selection-panel">
      <div className="panel-head formula-selection-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="target" size={16} />
          公式选股
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={run}
          disabled={running || !canRun}
          aria-busy={mode === activeRunMode}
          title={!canRun ? '盘中公式仅在连续竞价期间运行' : ''}
        >
          <Icon
            name={mode === activeRunMode ? 'refresh' : 'play'}
            size={14}
            className={mode === activeRunMode ? 'spin' : ''}
          />
          {mode === activeRunMode
            ? `计算中 ${Math.round(Number(currentTask?.percent) || 3)}%`
            : mode === 'intraday' ? '扫描当前机会' : '生成次日关注'}
        </button>
      </div>
      {tabs}
      <FormulaSelectionProgress task={activeTask} />
      <div className="formula-selection-body">
            {state.loading && !result && (
              <div className="formula-selection-state" role="status">
                正在读取公式结果…
              </div>
            )}
            {state.error && (
              <div className="formula-selection-state error" role="alert">
                {state.error}
              </div>
            )}
            {!state.loading && !state.error && !result && !currentTask && (
              <div className="formula-selection-state">
                {mode === 'intraday'
                  ? '尚无盘中结果'
                  : '尚无收盘次日关注结果'}
              </div>
            )}
            {result && (
              <>
                <div className="formula-selection-summary">
                  <strong>
                    {candidates.length
                      ? `${candidates.length}只公式观察股`
                      : '当前没有合格公式候选'}
                  </strong>
                  <span>
                    {formulaSummary || result.reason}
                  </span>
                  <time>
                    {new Date(result.dataAsOf || result.generatedAt)
                      .toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                  </time>
                </div>
                <div className="formula-selection-list">
                  {candidates.map((candidate) => (
                    <FormulaSelectionCandidate
                      key={candidate.code}
                      candidate={candidate}
                      added={(book.plan || []).some(
                        (item) => item.code === candidate.code,
                      )}
                      onAdd={add}
                    />
                  ))}
                </div>
                <div className="formula-selection-foot">
                  <span>
                    全市场完整读取{' '}
                    {result.universe?.inspectedCount ?? 0}
                    /{result.universe?.total ?? 0} 只
                  </span>
                  <span>仅作观察，不自动下单</span>
                </div>
              </>
            )}
      </div>
    </section>
  )
}
