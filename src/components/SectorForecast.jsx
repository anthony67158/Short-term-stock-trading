import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import Icon from './Icon'
import SectorForecastSettings from './SectorForecastSettings'
import { sectorForecastRequest } from '../sectorForecastClient.js'

const PHASE_LABELS = {
  ACCUMULATION: '潜伏吸筹',
  STARTUP: '启动扩散',
  ACCELERATION: '加速拥挤',
  DIVERGENCE: '高位分歧',
  RETREAT: '退潮转弱',
}

const ACTION_LABELS = {
  LAYOUT: '可提前布局',
  WAIT_PULLBACK: '等回踩',
  WATCH_ONLY: '只观察',
  AVOID: '回避',
}

export const phaseLabel = (value) =>
  PHASE_LABELS[value] || '待识别'

export const actionLabel = (value) =>
  ACTION_LABELS[value] || '观察'

const finite = (value) => Number.isFinite(Number(value))

function percent(value, digits = 0) {
  return finite(value) ? `${Number(value).toFixed(digits)}%` : '--'
}

function timeLabel(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function SectorExplanation({ sector }) {
  const explanation = sector.explanation || {}
  const catalysts = explanation.catalysts || []
  const risks = explanation.risks?.length
    ? explanation.risks
    : (sector.risks || [])
  const evidence = explanation.evidence || []
  return (
    <div className="sector-forecast-expanded">
      <div className="sector-forecast-thesis">
        <section>
          <h3>为什么现在</h3>
          <p>{explanation.whyNow || sector.reasons?.join('；') || '暂无补充解释'}</p>
        </section>
        <section>
          <h3>催化与反方</h3>
          <p>{catalysts.join('；') || explanation.counterCase || '暂无已核验催化'}</p>
        </section>
        <section>
          <h3>风险与失效</h3>
          <p>{risks.join('；') || explanation.invalidation || '暂无额外风险项'}</p>
        </section>
      </div>
      {!!sector.stocks?.length && (
        <div className="sector-forecast-stocks">
          <b>真实成分股</b>
          <div>
            {sector.stocks.map((stock) => (
              <span key={stock.code}>
                <strong>{stock.name}</strong>
                <small>{stock.roleLabel} · {stock.code}</small>
              </span>
            ))}
          </div>
        </div>
      )}
      {!!evidence.length && (
        <div className="sector-forecast-evidence">
          <b>待核验外部证据</b>
          <ul>
            {evidence.map((item, index) => (
              <li key={`${item.title}-${index}`}>
                <span>{item.title}</span>
                <small>{item.source || '公开检索'} {item.date || ''}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function SectorForecast() {
  const [horizon, setHorizon] = useState('next')
  const [latest, setLatest] = useState(null)
  const [history, setHistory] = useState([])
  const [settings, setSettings] = useState(null)
  const [task, setTask] = useState(null)
  const [expanded, setExpanded] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [current, archive, status] = await Promise.all([
      sectorForecastRequest(),
      sectorForecastRequest({
        action: 'history',
        query: { limit: 30 },
      }),
      sectorForecastRequest({ action: 'status' }),
    ])
    return {
      latest: current.latest || null,
      settings: current.settings || null,
      history: archive.history || [],
      task: status.task || null,
    }
  }, [])

  useEffect(() => {
    let ignore = false
    setLoading(true)
    load()
      .then((result) => {
        if (ignore) return
        setLatest(result.latest)
        setSettings(result.settings)
        setHistory(result.history)
        setTask(result.task)
        setGenerating(result.task?.active?.status === 'running')
        setError('')
      })
      .catch((reason) => {
        if (!ignore) setError(reason?.message || '板块前瞻暂时不可用')
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => { ignore = true }
  }, [load])

  useEffect(() => {
    if (!generating && !task?.active) return undefined
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const [status, current] = await Promise.all([
          sectorForecastRequest({ action: 'status' }),
          sectorForecastRequest(),
        ])
        if (stopped) return
        setTask(status.task || null)
        if (current.latest) setLatest(current.latest)
        if (!status.task?.active) setGenerating(false)
      } catch { /* 下一轮继续读取权威任务状态 */ }
    }, 4000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [generating, task?.active])

  const ranked = useMemo(() => {
    const key = horizon === 'week' ? 'weekRank' : 'rank'
    return (latest?.sectors || []).slice().sort((left, right) =>
      (Number(left[key]) || 999) - (Number(right[key]) || 999)
    )
  }, [horizon, latest])

  const generate = async () => {
    setGenerating(true)
    setError('')
    try {
      const response = await sectorForecastRequest({
        action: 'generate',
        method: 'POST',
        body: { session: 'close' },
        timeoutMs: 300000,
      })
      if (response.snapshot) setLatest(response.snapshot)
      const archive = await sectorForecastRequest({
        action: 'history',
        query: { limit: 30 },
      })
      setHistory(archive.history || [])
    } catch (reason) {
      setError(reason?.message || '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <section className="panel sector-forecast-panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title">
          <Icon name="compass" size={16} /> 板块前瞻
          <span className="sub-name">T+1强度 · T+5超额收益</span>
        </div>
        <div className="sector-forecast-head-actions">
          <div className="tabs" role="group" aria-label="板块前瞻周期">
            <button type="button" className={'tab' + (horizon === 'next' ? ' active' : '')}
              aria-pressed={horizon === 'next'} onClick={() => setHorizon('next')}>次日</button>
            <button type="button" className={'tab' + (horizon === 'week' ? ' active' : '')}
              aria-pressed={horizon === 'week'} onClick={() => setHorizon('week')}>一周</button>
          </div>
          <button type="button" className="row-btn" disabled={generating}
            onClick={generate}>
            <Icon name={generating ? 'pulse' : 'refresh'} size={14} />
            {generating ? '生成中' : '生成正式版'}
          </button>
          <button type="button" className="icon-btn"
            aria-label="板块前瞻自动设置" title="自动设置"
            onClick={() => setSettingsOpen((value) => !value)}>
            <Icon name="gauge" size={15} />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SectorForecastSettings
          key={`${settings?.closeTime}-${settings?.overnightTime}`}
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      )}

      {loading ? (
        <div className="loading sector-forecast-loading">正在读取板块前瞻…</div>
      ) : error && !latest ? (
        <div className="empty err">{error}</div>
      ) : !latest ? (
        <div className="empty">尚无正式版板块前瞻</div>
      ) : (
        <>
          <div className="sector-forecast-meta">
            <span>排名截至 <b>{latest.dataAsOf || latest.signalDate}</b></span>
            <span>{latest.session === 'overnight' ? '盘前证据已复核' : '收盘正式版'}</span>
            <span>量化 <b>{latest.model?.quant === 'lightgbm' ? 'LightGBM' : 'V1降级'}</b></span>
            <span>生成 <b>{timeLabel(latest.generatedAt)}</b></span>
          </div>
          {error && <div className="sector-forecast-inline-error" role="status">{error}</div>}
          <div className="sector-forecast-list">
            {ranked.map((sector) => {
              const rank = horizon === 'week' ? sector.weekRank : sector.rank
              const forecast = sector.forecast?.[horizon] || {}
              const isOpen = expanded === sector.code
              return (
                <div className={'sector-forecast-item' + (isOpen ? ' expanded' : '')}
                  key={`${horizon}-${sector.code}`}>
                  <button type="button" className="sector-forecast-row"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? '' : sector.code)}>
                    <span className="sector-forecast-rank">{rank || '--'}</span>
                    <span className="sector-forecast-name">
                      <strong>{sector.name}</strong>
                      <small>{sector.code}</small>
                    </span>
                    <span className="sector-forecast-state">
                      <b data-phase={sector.phase}>{phaseLabel(sector.phase)}</b>
                      <em data-action={sector.actionability}>{actionLabel(sector.actionability)}</em>
                    </span>
                    <span className="sector-forecast-score">
                      <strong>{finite(forecast.score) ? Number(forecast.score).toFixed(1) : '--'}</strong>
                      <small>{forecast.probability == null ? 'V1评分' : `概率 ${percent(forecast.probability)}`}</small>
                    </span>
                    <span className="sector-forecast-why">
                      {sector.explanation?.whyNow || sector.reasons?.[0] || '等待解释'}
                    </span>
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={15} />
                  </button>
                  {isOpen && <SectorExplanation sector={sector} />}
                </div>
              )
            })}
          </div>
          <details className="sector-forecast-history">
            <summary>
              <Icon name="history" size={14} />
              历史版本 <span>{history.length}</span>
            </summary>
            <div>
              {history.map((item) => (
                <span key={`${item.signalDate}-${item.session}`}>
                  <b>{item.signalDate}</b>
                  <small>{item.session === 'overnight' ? '盘前复核' : '收盘正式版'} · {item.sectorCount}个板块</small>
                </span>
              ))}
              {!history.length && <span>暂无历史版本</span>}
            </div>
          </details>
        </>
      )}
    </section>
  )
}
