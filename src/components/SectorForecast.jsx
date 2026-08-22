import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Icon from './Icon'
import SectorForecastProgress from './SectorForecastProgress'
import SectorForecastSettings from './SectorForecastSettings'
import { openStockDetail } from '../detailStore.js'
import { sectorForecastRequest } from '../sectorForecastClient.js'
import {
  assessSectorForecastGeneration,
  resolveSectorForecastGenerationSession,
  sectorForecastActionView,
  sortSectorForecasts,
  summarizeSectorForecastActions,
} from '../sectorForecastView.js'

const PHASE_LABELS = {
  ACCUMULATION: '潜伏吸筹',
  STARTUP: '启动扩散',
  ACCELERATION: '加速拥挤',
  DIVERGENCE: '高位分歧',
  RETREAT: '退潮转弱',
}

export const phaseLabel = (value) =>
  PHASE_LABELS[value] || '待识别'

export const actionLabel = (value) =>
  sectorForecastActionView(value).label

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

function SectorExplanation({ sector, session }) {
  const explanation = sector.explanation || {}
  const catalysts = explanation.catalysts || []
  const risks = explanation.risks?.length
    ? explanation.risks
    : (sector.risks || [])
  const evidence = explanation.evidence || []
  const action = sectorForecastActionView(
    sector.actionability,
    { session },
  )
  return (
    <div className="sector-forecast-expanded">
      <div
        className="sector-forecast-execution"
        data-intent={action.intent}
        role="note"
        aria-label={`操作指引：${action.label}`}
      >
        <Icon
          name={action.intent === 'buy' ? 'check' : 'shield'}
          size={16}
        />
        <div>
          <b>现在怎么做 · {action.label}</b>
          <p>
            {action.instruction}
            {' '}操作前点开成分股，核对个股买点与止损。
          </p>
        </div>
      </div>
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
              <button
                type="button"
                className="sector-forecast-stock"
                key={stock.code}
                aria-label={`查看个股详情：${stock.name}`}
                title={`查看${stock.name}个股详情`}
                onClick={() => openStockDetail(stock.code, stock.name)}
              >
                <strong>{stock.name}</strong>
                <small>{stock.roleLabel} · {stock.code}</small>
                <Icon name="chevronRight" size={14} />
              </button>
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
  const [sortMode, setSortMode] = useState('conclusion')
  const [latest, setLatest] = useState(null)
  const [intraday, setIntraday] = useState(null)
  const [market, setMarket] = useState(null)
  const [versionMode, setVersionMode] = useState('auto')
  const [history, setHistory] = useState([])
  const [settings, setSettings] = useState(null)
  const [task, setTask] = useState(null)
  const [expanded, setExpanded] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [generationNotice, setGenerationNotice] = useState(null)
  const generationRequestRef = useRef(false)
  const generationBaselineRef = useRef(0)
  const generationSession =
    resolveSectorForecastGenerationSession(market)

  const load = useCallback(async () => {
    const current = await sectorForecastRequest({
      action: 'bootstrap',
      query: { limit: 30 },
      timeoutMs: 30000,
    })
    return {
      latest: current.latest || null,
      intraday: current.intraday || null,
      market: current.market || null,
      settings: current.settings || null,
      history: current.history || [],
      task: current.task || null,
    }
  }, [])

  useEffect(() => {
    let ignore = false
    setLoading(true)
    load()
      .then((result) => {
        if (ignore) return
        setLatest(result.latest)
        setIntraday(result.intraday)
        setMarket(result.market)
        setSettings(result.settings)
        setHistory(result.history)
        setTask(result.task)
        if (result.task?.active?.status === 'running') {
          generationBaselineRef.current = Math.max(
            Number(result.latest?.generatedAt) || 0,
            Number(result.intraday?.generatedAt) || 0,
          )
        }
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
    const poll = async () => {
      try {
        const [status, current] = await Promise.all([
          sectorForecastRequest({ action: 'status' }),
          sectorForecastRequest(),
        ])
        if (stopped) return
        setTask(status.task || null)
        if (current.latest) setLatest(current.latest)
        if (current.intraday) setIntraday(current.intraday)
        if (current.market) setMarket(current.market)
        if (
          !status.task?.active
          && !generationRequestRef.current
        ) {
          setGenerating(false)
          const outcome = assessSectorForecastGeneration({
            previousGeneratedAt: generationBaselineRef.current,
            response: { ok: true, skipped: false },
            current: {
              ...current,
              task: status.task,
            },
            session: generationSession,
          })
          if (outcome.status === 'completed') {
            setError('')
            setGenerationNotice({
              tone: 'success',
              message: outcome.message,
            })
          } else if (status.task?.latest?.status === 'failed') {
            setGenerationNotice(null)
            setError(outcome.message)
          }
        }
      } catch { /* 下一轮继续读取权威任务状态 */ }
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [generating, generationSession, task?.active?.key])

  useEffect(() => {
    if (settings?.intradayEnabled === false) return undefined
    let stopped = false
    const refreshIntraday = async () => {
      try {
        const current = await sectorForecastRequest()
        if (stopped) return
        if (current.latest) setLatest(current.latest)
        if (current.intraday) setIntraday(current.intraday)
        if (current.market) setMarket(current.market)
      } catch { /* 下一轮继续读取全局盘中快照 */ }
    }
    const timer = setInterval(refreshIntraday, 60000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [settings?.intradayEnabled])

  const currentIntraday = !!(
    intraday?.signalDate
    && intraday.signalDate === market?.day
  )
  const effectiveVersion = versionMode === 'formal'
    ? 'formal'
    : versionMode === 'intraday'
      ? (currentIntraday ? 'intraday' : 'formal')
      : (
        currentIntraday
        && ['live', 'lunch'].includes(market?.phase)
          ? 'intraday'
          : 'formal'
      )
  const snapshot = effectiveVersion === 'intraday'
    ? intraday
    : latest
  const generationPaused = market?.phase === 'lunch'

  const ranked = useMemo(() => {
    return sortSectorForecasts(snapshot?.sectors || [], {
      horizon,
      sortMode,
    })
  }, [horizon, snapshot, sortMode])

  const actionSummary = useMemo(
    () => summarizeSectorForecastActions(snapshot?.sectors || []),
    [snapshot],
  )

  const generate = async () => {
    const previousSnapshot = generationSession === 'intraday'
      ? intraday
      : latest
    generationBaselineRef.current =
      Number(previousSnapshot?.generatedAt) || 0
    generationRequestRef.current = true
    setGenerating(true)
    setError('')
    setGenerationNotice(null)
    let keepGenerating = false
    try {
      const response = await sectorForecastRequest({
        action: 'generate',
        method: 'POST',
        body: { session: generationSession },
        timeoutMs: 300000,
      })
      if (response.snapshot?.session === 'intraday') {
        setIntraday(response.snapshot)
        setVersionMode('intraday')
      } else if (response.snapshot) {
        setLatest(response.snapshot)
        setVersionMode('formal')
      }
      const current = await sectorForecastRequest({
        action: 'bootstrap',
        query: { limit: 30 },
        timeoutMs: 30000,
      })
      setHistory(current.history || [])
      setTask(current.task || null)
      if (current.latest) setLatest(current.latest)
      if (current.intraday) setIntraday(current.intraday)
      if (current.market) setMarket(current.market)
      const outcome = assessSectorForecastGeneration({
        previousGeneratedAt: generationBaselineRef.current,
        response,
        current,
        session: generationSession,
      })
      keepGenerating = outcome.status === 'running'
      if (outcome.status === 'completed') {
        setGenerationNotice({
          tone: 'success',
          message: outcome.message,
        })
      } else if (outcome.status === 'running') {
        setGenerationNotice({
          tone: 'running',
          message: outcome.message,
        })
      } else {
        setError(outcome.message)
      }
    } catch (reason) {
      setError(reason?.message || '生成失败')
    } finally {
      generationRequestRef.current = false
      setGenerating(keepGenerating)
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
          <label className="sector-forecast-sort">
            <Icon name="filter" size={14} />
            <span>排序</span>
            <select
              aria-label="板块前瞻排序"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value)}
            >
              <option value="rank">原始排名</option>
              <option value="conclusion">结论优先</option>
              <option value="score_desc">分数从高到低</option>
              <option value="score_asc">分数从低到高</option>
            </select>
          </label>
          <button type="button" className="row-btn sector-forecast-generate"
            disabled={generating || generationPaused}
            onClick={generate}>
            <Icon name={generating ? 'pulse' : 'refresh'} size={14} />
            {generationPaused
              ? '午间暂停'
              : generating
              ? generationSession === 'intraday'
                ? '刷新中'
                : generationSession === 'overnight'
                  ? '复核中'
                  : '生成中'
              : generationSession === 'intraday'
                ? '刷新盘中版'
                : generationSession === 'overnight'
                  ? '复核盘前证据'
                    : market?.tradingDay === false
                      ? '重算最近正式版'
                      : '生成正式版'}
          </button>
          <button type="button" className="icon-btn sector-forecast-settings-trigger"
            aria-label="板块前瞻自动设置" title="自动设置"
            onClick={() => setSettingsOpen((value) => !value)}>
            <Icon name="gauge" size={15} />
          </button>
        </div>
      </div>

      {settingsOpen && (
        <SectorForecastSettings
          key={`${settings?.closeTime}-${settings?.overnightTime}-${settings?.intradayIntervalMinutes}`}
          initial={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      )}

      <SectorForecastProgress
        task={task}
        generating={generating}
      />
      {generationNotice && (
        <div
          className={`sector-forecast-generation-notice ${generationNotice.tone}`}
          role="status"
        >
          <Icon
            name={generationNotice.tone === 'success' ? 'check' : 'pulse'}
            size={14}
          />
          <span>{generationNotice.message}</span>
        </div>
      )}

      {loading ? (
        <div className="loading sector-forecast-loading">正在读取板块前瞻…</div>
      ) : error && !snapshot ? (
        <div className="empty err">{error}</div>
      ) : !snapshot ? (
        <div className="empty">尚无正式版板块前瞻</div>
      ) : (
        <>
          <div className="sector-forecast-version-bar">
            <div
              className="sector-forecast-version-switch"
              role="group"
              aria-label="板块前瞻版本"
            >
              <button
                type="button"
                className={effectiveVersion === 'intraday' ? 'active' : ''}
                aria-pressed={effectiveVersion === 'intraday'}
                disabled={!currentIntraday}
                onClick={() => setVersionMode('intraday')}
              >
                <Icon name="pulse" size={13} />
                盘中动态
              </button>
              <button
                type="button"
                className={effectiveVersion === 'formal' ? 'active' : ''}
                aria-pressed={effectiveVersion === 'formal'}
                onClick={() => setVersionMode('formal')}
              >
                <Icon name="history" size={13} />
                正式基线
              </button>
            </div>
            <span>
              {effectiveVersion === 'intraday'
                ? market?.phase === 'lunch'
                  ? '午间暂停，13:00后继续更新'
                  : '实时资金与成分股扩散重算，日终量化概率仅作先验'
                : market?.phase === 'live'
                  ? '当前查看收盘/盘前基线，可切换盘中动态版'
                  : '收盘正式排名与盘前证据复核'}
            </span>
          </div>
          <div className="sector-forecast-meta">
            <span>排名截至 <b>{snapshot.dataAsOf || snapshot.signalDate}</b></span>
            <span>
              {snapshot.session === 'intraday'
                ? '盘中动态版'
                : snapshot.session === 'overnight'
                  ? '盘前证据已复核'
                  : '收盘正式版'}
            </span>
            <span>量化 <b>
              {snapshot.model?.quant === 'lightgbm'
                ? 'LightGBM'
                : snapshot.model?.quant === 'lightgbm-prior'
                  ? '日终先验 + 实时'
                  : 'V1降级'}
            </b></span>
            <span>生成 <b>{timeLabel(snapshot.generatedAt)}</b></span>
          </div>
          {ranked.length ? (
            <div
              className="sector-forecast-action-summary"
              data-has-buy={actionSummary.counts.buy > 0}
              role="status"
            >
              <Icon
                name={actionSummary.counts.buy > 0 ? 'check' : 'shield'}
                size={16}
              />
              <div>
                <strong>
                  {actionSummary.counts.buy > 0
                    ? `当前可买 ${actionSummary.counts.buy} 个`
                    : '当前没有通过买入闸门的板块'}
                </strong>
                <span>
                  {actionSummary.counts.buy > 0
                    ? `${actionSummary.buyable.slice(0, 3).map((item) => item.name).join('、')}；列表已按结论优先排列`
                    : '今天先不买，等待资金、位置和量化信号重新共振'}
                </span>
              </div>
              <small>
                暂不买 {actionSummary.counts.wait} ·
                {' '}观察/回避 {actionSummary.noBuy}
              </small>
            </div>
          ) : (
            <div className="sector-forecast-empty-result" role="alert">
              <Icon name="info" size={16} />
              <div>
                <strong>本版没有有效板块数据</strong>
                <span>
                  未形成买卖结论，系统会保留上一份有效基线；盘前只复核证据，开盘后再刷新实时排名。
                </span>
              </div>
            </div>
          )}
          {error && <div className="sector-forecast-inline-error" role="status">{error}</div>}
          <div className="sector-forecast-list">
            {ranked.map((sector, index) => {
              const rank = horizon === 'week'
                ? sector.weekRank
                : sector.rank
              const displayRank = sortMode === 'rank'
                ? rank
                : index + 1
              const forecast = sector.forecast?.[horizon] || {}
              const action = sectorForecastActionView(
                sector.actionability,
                { session: snapshot.session },
              )
              const isOpen = expanded === sector.code
              return (
                <div className={'sector-forecast-item' + (isOpen ? ' expanded' : '')}
                  key={`${horizon}-${sector.code}`}>
                  <button type="button" className="sector-forecast-row"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? '' : sector.code)}>
                    <span className="sector-forecast-rank">
                      {displayRank || '--'}
                    </span>
                    <span className="sector-forecast-name">
                      <strong>{sector.name}</strong>
                      <small>
                        {sortMode === 'rank'
                          ? sector.code
                          : `原排名 #${rank || '--'} · ${sector.code}`}
                      </small>
                    </span>
                    <span className="sector-forecast-state">
                      <b data-phase={sector.phase}>{phaseLabel(sector.phase)}</b>
                      <em
                        data-action={sector.actionability}
                        data-intent={action.intent}
                      >
                        {action.label}
                      </em>
                    </span>
                    <span className="sector-forecast-score">
                      <strong>{finite(forecast.score) ? Number(forecast.score).toFixed(1) : '--'}</strong>
                      <small>{forecast.probability == null ? 'V1评分' : `概率 ${percent(forecast.probability)}`}</small>
                    </span>
                    <span
                      className="sector-forecast-guidance"
                      data-intent={action.intent}
                    >
                      <strong>{action.instruction}</strong>
                      <small>
                        {sector.explanation?.whyNow
                          || sector.reasons?.[0]
                          || '等待解释'}
                      </small>
                    </span>
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={15} />
                  </button>
                  {isOpen && (
                    <SectorExplanation
                      sector={sector}
                      session={snapshot.session}
                    />
                  )}
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
