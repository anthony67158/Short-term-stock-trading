import { useEffect, useMemo, useState } from 'react'
import {
  isContinuousTrading,
} from '../../shared/tradingCalendar.js'
import {
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
  })
  const [running, setRunning] = useState(false)
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
        })
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
  const canRun = mode === 'close' || isContinuousTrading(Date.now())
  const formulaSummary = useMemo(
    () => (result?.formulas || [])
      .map((item) => `${item.name}${item.candidateCount}`)
      .join(' · '),
    [result],
  )

  const run = async () => {
    if (running || mode === 'tail' || !canRun) return
    setRunning(true)
    setState((current) => ({ ...current, error: '' }))
    try {
      const payload = await runFormulaSelection(mode)
      setState((current) => ({
        ...current,
        [mode]: payload,
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        error: String(error?.message || error),
      }))
    } finally {
      setRunning(false)
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

  return (
    <>
      <section className="panel formula-selection-panel">
        <div className="panel-head formula-selection-head">
          <div role="heading" aria-level="2" className="panel-title">
            <Icon name="target" size={16} />
            公式选股
          </div>
          {mode !== 'tail' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={run}
              disabled={running || !canRun}
              title={!canRun ? '盘中公式仅在连续竞价期间运行' : ''}
            >
              <Icon name={running ? 'refresh' : 'play'} size={14} />
              {running
                ? '计算中'
                : mode === 'intraday' ? '扫描当前机会' : '生成次日关注'}
            </button>
          )}
        </div>
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

        {mode !== 'tail' && (
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
            {!state.loading && !state.error && !result && (
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
                    全市场检查 {result.universe?.inspectedCount ?? 0} 只
                  </span>
                  <span>仅作观察，不自动下单</span>
                </div>
              </>
            )}
          </div>
        )}
      </section>
      {mode === 'tail' && <TailPick />}
    </>
  )
}
