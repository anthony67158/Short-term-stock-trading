import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  evaluateAccountCircuitBreaker,
} from '../../shared/accountCircuitBreaker.js'
import Icon from './Icon'
import TailPickResults from './TailPickResults'
import {
  planStore,
  usePlanStore,
} from '../planStore.js'
import {
  loadTailPickState,
  runTailPick,
} from '../tailPickClient.js'

const STAGES = {
  MARKET_GATE: '确认开仓环境',
  FORMULA_SCAN: '扫描公式信号',
  DISCIPLINE_GATE: '执行纪律过滤',
  DONE: '生成最终顺序',
}

function accountRiskGate(book) {
  const totalAssets = Number(book.account?.totalAssets) || 0
  const cash = Number(book.account?.cash)
  const position = (
    totalAssets > 0 && Number.isFinite(cash)
      ? Math.max(0, (totalAssets - cash) / totalAssets * 100)
      : 0
  )
  return evaluateAccountCircuitBreaker({
    account: book.account,
    portfolio: {
      position,
      industryWeights: [],
    },
    closed: book.closed,
    executionPlans: book.executionPlans,
  })
}

export default function TailPick() {
  const book = usePlanStore()
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const accountGate = useMemo(() => accountRiskGate(book), [book])

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const next = await loadTailPickState()
      if (!mounted.current) return
      setState(next)
      setError('')
      if (next.task?.status === 'RUNNING') setRunning(true)
      else if (!quiet) setRunning(false)
    } catch (loadError) {
      if (mounted.current) {
        setError(loadError.message || '尾盘选股状态读取失败')
      }
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
    setRunning(true)
    setError('')
    try {
      await runTailPick(tradeDate)
      await load({ quiet: true })
    } catch (runError) {
      setError(runError.message || '尾盘选股运行失败')
      await load({ quiet: true })
    } finally {
      if (mounted.current) setRunning(false)
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
    <section className="panel tail-pick-panel">
      <div className="panel-head">
        <div
          role="heading"
          aria-level="2"
          className="panel-title"
        >
          <Icon name="target" size={16} />
          尾盘拾金
          <span className="sub-name">14:50 自动正式扫描 · 随时手动试算</span>
        </div>
        <button
          type="button"
          className="btn btn-primary tail-pick-run"
          disabled={runDisabled}
          onClick={run}
        >
          <Icon name={running ? 'refresh' : 'play'} size={14} />
          {buttonLabel}
        </button>
      </div>

      {running && (
        <div
          className="tail-pick-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progress}
          aria-live="polite"
        >
          <span style={{ width: `${progress}%` }} />
          <b>{STAGES[task?.stage] || '准备扫描'}</b>
          <em>{progress}%</em>
        </div>
      )}

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
          accountGate={accountGate}
          allowExecution={
            !!state?.currentResult
            && session.status === 'OPEN'
            && accountGate.allowRiskIncrease
          }
          onAdd={addCandidate}
        />
      )}
    </section>
  )
}
