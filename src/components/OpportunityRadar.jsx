import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  loadOpportunityRadar,
  opportunityRadarAutoRefreshDelay,
  refreshOpportunityRadar,
  refreshTailOpportunity,
} from '../opportunityRadarClient.js'
import {
  planStore,
  usePlanStore,
} from '../planStore.js'
import Icon from './Icon'
import OpportunityRadarContent from './OpportunityRadarContent'
import SectorForecastSettings from './SectorForecastSettings'

const LANES = Object.freeze([
  { id: 'intraday', label: '盘中机会' },
  { id: 'next', label: '次日关注计划' },
])

const SOURCE_NAMES = Object.freeze({
  sector: '板块方向',
  formulaIntraday: '盘中公式',
  formulaClose: '收盘公式',
  tail: '尾盘反转',
})

const PHASE_NAMES = Object.freeze({
  PREOPEN: '盘前',
  INTRADAY: '盘中',
  LUNCH: '午间',
  AFTER_CLOSE: '收盘后',
  REST: '休市',
})

function activeTask(task) {
  const value = task?.active || task
  return ['running', 'RUNNING', 'QUEUED'].includes(value?.status)
}

function taskMessage(task) {
  const value = task?.active || task
  return value?.progress?.message || value?.message || '正在更新'
}

function refreshLabel(lane, snapshot) {
  if (lane === 'intraday') return '扫描盘中机会'
  if (snapshot?.phase === 'AFTER_CLOSE') return '生成次日关注'
  return '收盘后可生成'
}

export default function OpportunityRadar() {
  const book = usePlanStore()
  const [snapshot, setSnapshot] = useState(null)
  const [lane, setLane] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [sourceRuns, setSourceRuns] = useState({})
  const laneSelected = useRef(false)

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const next = await loadOpportunityRadar()
      setSnapshot(next)
      if (!laneSelected.current) setLane(next.defaultLane || 'next')
      setError('')
      return next
    } catch (reason) {
      setError(reason?.message || '机会雷达暂时不可用')
      return null
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    load().then((next) => {
      if (!active || !next) return
      setSnapshot(next)
    })
    return () => { active = false }
  }, [load])

  const autoRefreshDelay = opportunityRadarAutoRefreshDelay(
    snapshot,
    Date.now(),
    { refreshing },
  )

  useEffect(() => {
    if (autoRefreshDelay == null) return undefined
    const timer = setTimeout(() => {
      void load({ quiet: true })
    }, autoRefreshDelay)
    return () => clearTimeout(timer)
  }, [
    autoRefreshDelay,
    error,
    load,
    refreshing,
    snapshot?.generatedAt,
  ])

  const selectLane = (value) => {
    laneSelected.current = true
    setLane(value)
  }

  const refresh = async () => {
    if (refreshing || !snapshot || !canRefresh) return
    setRefreshing(true)
    setError('')
    setSourceRuns({})
    try {
      const result = await refreshOpportunityRadar({
        lane: lane || snapshot.defaultLane,
        snapshot,
        onSourceState: (source, status, message = '') => {
          setSourceRuns((current) => ({
            ...current,
            [source]: { status, message },
          }))
        },
      })
      setSnapshot(result.snapshot)
      if (result.failed.length) {
        setError(
          `${result.failed.map((item) => SOURCE_NAMES[item] || item)
            .join('、')}更新失败，其它结果已保留`,
        )
      }
    } catch (reason) {
      setError(reason?.message || '机会雷达更新失败')
    } finally {
      setRefreshing(false)
    }
  }

  const refreshTail = async () => {
    if (tailRunning || !snapshot?.tailSession?.canRun) return
    setError('')
    try {
      const next = await refreshTailOpportunity({
        snapshot,
        onSourceState: (source, status, message = '') => {
          setSourceRuns((current) => ({
            ...current,
            [source]: { status, message },
          }))
        },
      })
      setSnapshot(next)
    } catch (reason) {
      setError(reason?.message || '尾盘公式运行失败')
    }
  }

  const add = async (opportunity) => {
    const entry = opportunity.entryPlan?.price
    const exit = opportunity.exitPlan
    planStore.addPlan(
      {
        code: opportunity.code,
        name: opportunity.name,
      },
      `机会雷达：${opportunity.stateLabel}；`
        + `${entry ? `关注价${Number(entry).toFixed(2)}；` : ''}`
        + `${exit?.hardStopPrice
          ? `止损${Number(exit.hardStopPrice).toFixed(2)}；`
          : ''}`
        + `${exit?.timeStopDate ? `最晚${exit.timeStopDate}复核` : ''}`,
    )
    await planStore.flushSave()
  }

  const taskRows = Object.entries(snapshot?.tasks || {})
    .filter(([, task]) => activeTask(task))
    .map(([source, task]) => ({
      source,
      message: taskMessage(task),
    }))
  const localRuns = Object.entries(sourceRuns)
    .filter(([, value]) => value.status === 'running')
    .map(([source, value]) => ({
      source,
      message: value.message || '正在更新',
    }))
  const progressRows = [...new Map(
    [...taskRows, ...localRuns]
      .map((item) => [item.source, item]),
  ).values()]
  const currentLane = lane || snapshot?.defaultLane || 'next'
  const canRefresh = currentLane === 'intraday'
    ? snapshot?.phase === 'INTRADAY'
    : snapshot?.phase === 'AFTER_CLOSE'
  const tailRunning = (
    sourceRuns.tail?.status === 'running'
    || activeTask(snapshot?.tasks?.tail)
  )

  return (
    <section className="panel opportunity-radar">
      <div className="panel-head opportunity-radar-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="radar" size={16} />
          机会雷达
          <span className="sub-name">全站唯一选股入口</span>
          {snapshot?.phase && (
            <span className="opportunity-phase">
              {PHASE_NAMES[snapshot.phase] || '当前'}
            </span>
          )}
        </div>
        <div className="opportunity-radar-head-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={loading || refreshing || !snapshot || !canRefresh}
            aria-busy={refreshing}
            onClick={refresh}
            title={!canRefresh
              ? currentLane === 'next'
                ? '收盘后可手动生成次日关注计划'
                : '盘中公式仅在连续竞价期间运行'
              : ''}
          >
            <Icon
              name={refreshing ? 'refresh' : 'play'}
              size={14}
              className={refreshing ? 'spin' : ''}
            />
            {refreshing
              ? '正在更新'
              : refreshLabel(currentLane, snapshot)}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="机会雷达自动设置"
            title="自动设置"
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Icon name="gauge" size={15} />
          </button>
        </div>
      </div>

      <div
        className="opportunity-radar-tabs"
        role="tablist"
        aria-label="机会雷达视图"
      >
        {LANES.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={currentLane === item.id}
            className={currentLane === item.id ? 'active' : ''}
            key={item.id}
            onClick={() => selectLane(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {settingsOpen && (
        <SectorForecastSettings
          initial={snapshot?.settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(settings) => setSnapshot((current) => ({
            ...current,
            settings,
          }))}
        />
      )}

      {!!progressRows.length && (
        <div className="opportunity-radar-progress" role="status">
          {progressRows.map((item) => (
            <span key={item.source}>
              <Icon name="pulse" size={13} />
              <b>{SOURCE_NAMES[item.source] || item.source}</b>
              {item.message}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="opportunity-radar-error" role="status">
          <Icon name="info" size={14} />
          {error}
        </div>
      )}

      {loading && !snapshot ? (
        <div className="loading">正在汇总板块与个股机会…</div>
      ) : snapshot ? (
        <OpportunityRadarContent
          lane={currentLane}
          snapshot={snapshot}
          book={book}
          onAdd={add}
          onRunTail={refreshTail}
          tailRunning={tailRunning}
        />
      ) : (
        <div className="empty">暂无可用机会数据</div>
      )}
    </section>
  )
}
