import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import Icon from './Icon'
import FormulaSelectionProgress from './FormulaSelectionProgress'
import TailPickResults from './TailPickResults'
import {
  planStore,
  usePlanStore,
} from '../planStore.js'
import {
  isActiveTailPickTask,
  loadTailPickState,
  runTailPick,
} from '../tailPickClient.js'

const STAGES = {
  QUEUED: '等待云端扫描',
  MARKET_GATE: '读取大盘环境',
  FORMULA_SCAN: '扫描公式信号',
  DISCIPLINE_GATE: '汇总风险指标',
  DONE: '整理计算结果',
}

export default function TailPick({
  title = '尾盘拾金',
  navigation = null,
}) {
  const book = usePlanStore()
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const next = await loadTailPickState()
      if (!mounted.current) return
      setState(next)
      setError('')
      setRunning(isActiveTailPickTask(next.task))
      return next
    } catch (loadError) {
      if (mounted.current) {
        setError(loadError.message || '尾盘选股状态读取失败')
      }
      return null
    } finally {
      if (mounted.current && !quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false }
  }, [load])

  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => {
      void load({ quiet: true })
    }, 1500)
    return () => clearInterval(timer)
  }, [running, load])

  useEffect(() => {
    if (running) return undefined
    const timer = setInterval(() => {
      void load({ quiet: true })
    }, 15_000)
    return () => clearInterval(timer)
  }, [running, load])

  const run = async () => {
    const tradeDate = state?.session?.tradeDate
    if (!tradeDate || running) return
    let keepRunning = false
    setRunning(true)
    setError('')
    try {
      const submitted = await runTailPick(tradeDate)
      keepRunning = submitted?.running === true
      if (keepRunning && mounted.current) {
        setState((current) => ({
          ...current,
          task: submitted.task || current?.task,
        }))
      } else {
        const next = await load({ quiet: true })
        keepRunning = isActiveTailPickTask(next?.task)
      }
    } catch (runError) {
      const next = await load({ quiet: true })
      keepRunning = isActiveTailPickTask(next?.task)
      if (!keepRunning && mounted.current) {
        setError(runError.message || '尾盘选股运行失败')
      }
    } finally {
      if (mounted.current && !keepRunning) setRunning(false)
    }
  }

  const addCandidate = async (candidate) => {
    const role = candidate.execution?.role
    const sourceLabel = role === 'PRIMARY'
      ? '首选'
      : role === 'NEAR'
        ? '接近公式'
        : '候补'
    planStore.addPlan(
      { code: candidate.code, name: candidate.name },
      `尾盘拾金${sourceLabel}；`
        + `${candidate.execution?.action || ''}`,
    )
    await planStore.flushSave()
  }

  const session = state?.session || {}
  const result = state?.displayResult || null
  const task = state?.task
  const progress = running
    ? Math.max(3, Number(task?.progress) || 3)
    : 0
  const runDisabled = (
    loading
    || running
    || !session.canRun
  )
  const buttonLabel = running
    ? STAGES[task?.stage] || '正在运行'
    : session.label || '读取状态'

  return (
    <section
      className={
        'panel tail-pick-panel'
        + (navigation ? ' formula-selection-panel' : '')
      }
    >
      <div className="panel-head">
        <div
          role="heading"
          aria-level="2"
          className="panel-title"
        >
          <Icon name="target" size={16} />
          {title}
          <span className="sub-name">14:50 自动正式扫描 · 随时手动试算</span>
        </div>
        <button
          type="button"
          className="btn btn-primary tail-pick-run"
          disabled={runDisabled}
          aria-busy={running}
          onClick={run}
        >
          <Icon
            name={running ? 'refresh' : 'play'}
            size={14}
            className={running ? 'spin' : ''}
          />
          {buttonLabel}
        </button>
      </div>

      {navigation}

      <FormulaSelectionProgress
        task={running
          ? {
              ...task,
              status: 'RUNNING',
              percent: progress,
              message: STAGES[task?.stage] || '准备扫描',
            }
          : null}
        mode="tail"
      />

      {error && <div className="err tail-pick-error">{error}</div>}

      {!loading && !result && !error && (
        <div className="tail-pick-status">
          <Icon name="clock" size={18} />
          <div>
            <strong>{session.label}</strong>
            <span>
              {session.reason
                || '交易日14:50自动生成正式版；手动试算不覆盖正式结果'}
            </span>
          </div>
        </div>
      )}

      {result && (
        <TailPickResults
          result={result}
          book={book}
          allowExecution={
            result?.session?.isFormal === true
            && !!state?.currentResult
            && session.status === 'OPEN'
          }
          onAdd={addCandidate}
        />
      )}
    </section>
  )
}
