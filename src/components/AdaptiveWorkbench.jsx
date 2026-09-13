import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  loadOpportunityRadar,
  opportunityRadarAutoRefreshDelay,
  opportunityRadarHasStaleModelSource,
  opportunityRadarLaneSummary,
  refreshOpportunityRadar,
} from '../opportunityRadarClient.js'
import {
  computePortfolio,
  planStore,
  todayCommandList,
} from '../planStore.js'
import { buildWatchSpec } from '../adviceDaily.js'
import { tryStartAdvice } from '../adviceGate.js'
import {
  buildAccountRiskContext,
} from '../../shared/accountRiskBudget.js'
import {
  buildMarketOpportunityContext,
} from '../../shared/marketOpportunityContext.js'
import {
  selectionOriginFromOpportunity,
} from '../../shared/selectionOrigin.js'
import { openStockDetail } from '../detailStore.js'
import Icon from './Icon.jsx'
import StrategyPatternEvidence from './StrategyPatternEvidence.jsx'

const PHASE_LABELS = Object.freeze({
  TREND_EXPANSION: '趋势扩张',
  MAINLINE_ADVANCE: '主线推进',
  RECOVERY: '修复',
  ROTATION: '快速轮动',
  DIVERGENCE: '高分歧',
  HIGH_VOLATILITY: '高波动',
  RETREAT: '退潮',
  PANIC: '恐慌释放',
})

const ROUTE_LABELS = Object.freeze({
  IMMEDIATE: '现价',
  PULLBACK: '回踩',
  BREAKOUT: '突破',
})

const COMMAND_STATES = new Set([
  'CONFLICT',
  'RISK_EXIT',
  'READY_EXIT',
  'READY',
  'RECORD',
])

function number(value, digits = 2) {
  if (value == null || value === '') return '--'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : '--'
}

function signed(value, suffix = '') {
  if (value == null || value === '') return '--'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '--'
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(2)}${suffix}`
}

function probability(value) {
  if (value == null || value === '') return '--'
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `${Math.round(parsed * 100)}%` : '--'
}

function phaseTone(phase) {
  if (['TREND_EXPANSION', 'MAINLINE_ADVANCE', 'RECOVERY'].includes(phase)) {
    return 'positive'
  }
  if (['RETREAT', 'PANIC'].includes(phase)) return 'risk'
  return 'neutral'
}

function countdown(untilAt, now) {
  const deadline = Number(untilAt)
  if (!Number.isFinite(deadline) || deadline <= 0) return '--:--'
  const remaining = Math.max(0, deadline - now)
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function WorkbenchHeader({ context, risk, commandCount }) {
  const availableRisk = risk?.availableRisk == null
    ? null
    : Number(risk.availableRisk)
  return (
    <header className="aw-header" data-tone={phaseTone(context.phase)}>
      <div className="aw-market">
        <span className="aw-kicker">当前交易环境</span>
        <strong>{PHASE_LABELS[context.phase] || '等待市场数据'}</strong>
        <p>{context.note}</p>
      </div>
      <dl className="aw-market-metrics">
        <div>
          <dt>机会强度</dt>
          <dd>{number(context.score, 0)}</dd>
        </div>
        <div>
          <dt>市场倍率</dt>
          <dd>{number(context.opportunityFactor, 2)}x</dd>
        </div>
        <div>
          <dt>剩余风险</dt>
          <dd>{Number.isFinite(availableRisk)
            ? `¥${Math.round(availableRisk)}`
            : '--'}</dd>
        </div>
        <div>
          <dt>立即处理</dt>
          <dd>{commandCount}</dd>
        </div>
      </dl>
    </header>
  )
}

function CurrentInstruction({ commands, onOpen }) {
  const urgent = commands.filter((item) => COMMAND_STATES.has(item.state))
  const waiting = commands.filter((item) => !COMMAND_STATES.has(item.state))
  const command = urgent[0] || waiting[0] || null
  return (
    <section className="aw-section aw-focus" aria-labelledby="aw-actions-title">
      <div className="aw-section-head">
        <div>
          <span className="aw-kicker">现在该做什么</span>
          <h2 id="aw-actions-title">唯一当前指令</h2>
        </div>
        <span className="aw-section-meta">
          {urgent.length > 1
            ? `另有${urgent.length - 1}项待处理`
            : `${waiting.length}项等待条件`}
        </span>
      </div>
      <div className="aw-command-list">
        {command ? (
          <button
            type="button"
            className="aw-command"
            data-state={command.state}
            onClick={() => onOpen(command.code, command.name)}
          >
            <span className="aw-command-stock">
              <strong>{command.name}</strong>
              <small>{command.code}</small>
            </span>
            <span className="aw-command-main">
              <b>{command.actionLabel}</b>
              <small>{command.instruction || '等待当前条件确认'}</small>
            </span>
            <span className="aw-command-value">
              {command.quantity || (
                command.keyPrice != null
                  ? `¥${number(command.keyPrice)}`
                  : '查看'
              )}
            </span>
            <Icon name="chevronRight" size={15} />
          </button>
        ) : (
          <div className="aw-empty">
            <Icon name="check" size={18} />
            <span>当前无需操作，继续等待系统确认</span>
          </div>
        )}
      </div>
    </section>
  )
}

function ObservationQueue({ alerts, now, onOpen }) {
  const rows = (Array.isArray(alerts) ? alerts : [])
    .filter((item) =>
      item?.reviewOnly === true
      && ['watching', 'reviewing'].includes(item.phase))
    .sort((left, right) =>
      Number(left.monitoringUntilAt || Infinity)
      - Number(right.monitoringUntilAt || Infinity))
    .slice(0, 4)
  return (
    <section className="aw-section aw-observations" aria-labelledby="aw-observations-title">
      <div className="aw-section-head">
        <div>
          <span className="aw-kicker">正在等待什么</span>
          <h2 id="aw-observations-title">触价观察</h2>
        </div>
        <span className="aw-section-meta">{rows.length}项进行中</span>
      </div>
      <div className="aw-compact-list">
        {rows.length ? rows.map((alert) => {
          const observing = alert.phase === 'watching'
          return (
            <button
              type="button"
              className="aw-compact-row"
              key={alert.id}
              onClick={() => onOpen(alert.code, alert.name)}
            >
              <Icon name={observing ? 'clock' : 'refresh'} size={16} />
              <span>
                <strong>{alert.name || alert.code}</strong>
                <small>
                  {observing
                    ? alert.watchingMsg || '正在采集触价后路径'
                    : '观察完成，正在重新评估'}
                </small>
              </span>
              <b>{observing
                ? countdown(alert.monitoringUntilAt, now)
                : '复核中'}</b>
            </button>
          )
        }) : (
          <div className="aw-empty">
            <Icon name="clock" size={18} />
            <span>暂无触价后的观察任务</span>
          </div>
        )}
      </div>
    </section>
  )
}

function PositionProtection({ book, quoteMap, onOpen }) {
  const rows = (book.holding || []).slice(0, 5).map((holding) => {
    const advice = book.advice?.[holding.code]?.advice || {}
    const stopRule = (advice.executionRules || []).find((rule) =>
      (rule.conditions || []).some((condition) =>
        condition.metric === 'price' && condition.op === 'lte'))
    const stop = Number(
      stopRule?.conditions?.find((condition) =>
        condition.metric === 'price' && condition.op === 'lte')?.value
      ?? holding.sl,
    )
    const price = Number(quoteMap[holding.code]?.price)
    const distance = stop > 0 && price > 0
      ? (price / stop - 1) * 100
      : null
    return { holding, advice, stop, price, distance }
  })
  return (
    <section className="aw-section aw-protection" aria-labelledby="aw-protection-title">
      <div className="aw-section-head">
        <div>
          <span className="aw-kicker">持仓如何退出</span>
          <h2 id="aw-protection-title">动态保护</h2>
        </div>
        <span className="aw-section-meta">{rows.length}只持仓</span>
      </div>
      <div className="aw-compact-list">
        {rows.length ? rows.map(({ holding, stop, distance }) => (
          <button
            type="button"
            className="aw-compact-row"
            data-risk={distance != null && distance <= 0}
            key={holding.id || holding.code}
            onClick={() => onOpen(holding.code, holding.name)}
          >
            <Icon name="shield" size={16} />
            <span>
              <strong>{holding.name || holding.code}</strong>
              <small>
                {stop > 0
                  ? `动态保护价 ¥${number(stop)}`
                  : '等待系统核定保护价'}
              </small>
            </span>
            <b>{distance == null
              ? '--'
              : distance <= 0
                ? '已触发'
                : `余量 ${number(distance, 1)}%`}</b>
          </button>
        )) : (
          <div className="aw-empty">
            <Icon name="shield" size={18} />
            <span>当前没有需要管理的持仓</span>
          </div>
        )}
      </div>
    </section>
  )
}

export function OpportunityRow({
  opportunity,
  rank,
  held,
  managed,
  enrolling,
  onAdd,
  onOpen,
}) {
  const adaptive = opportunity.adaptive || {}
  const estimate = adaptive.estimate || {}
  const entry = opportunity.entryPlan || {}
  const exit = opportunity.exitPlan || {}
  return (
    <article
      className="aw-opportunity"
      data-tier={adaptive.tier || 'WATCH'}
    >
      <span className="aw-rank">{String(rank).padStart(2, '0')}</span>
      <button
        type="button"
        className="aw-stock"
        onClick={() => onOpen(opportunity.code, opportunity.name)}
      >
        <strong>{opportunity.name}</strong>
        <small>
          {opportunity.code}
          {opportunity.sector?.name
            ? ` · ${opportunity.sector.name}`
            : ''}
        </small>
      </button>
      <div className="aw-playbook">
        <span>{adaptive.playbook?.label || '等待分类'}</span>
        <strong>{adaptive.actionLabel || opportunity.stateLabel}</strong>
      </div>
      <div className="aw-route">
        <span>{ROUTE_LABELS[entry.type] || entry.type || '观察'}</span>
        <strong>{number(entry.price)}</strong>
        <small>
          止损 {number(exit.hardStopPrice)}
          {' · '}目标 {number(exit.takeProfitPrice)}
        </small>
      </div>
      <div className="aw-budget">
        <span>风险 {number(adaptive.risk?.riskPct, 2)}%</span>
        <strong>仓位≤{number(entry.maxPositionPct, 1)}%</strong>
      </div>
      <div className="aw-row-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={`查看${opportunity.name}`}
          title="查看详情"
          onClick={() => onOpen(opportunity.code, opportunity.name)}
        >
          <Icon name="chart" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={held
            ? `${opportunity.name}已持有`
            : managed
              ? `${opportunity.name}已纳入作战`
            : `将${opportunity.name}纳入作战`}
          title={held
            ? '当前已持有'
            : managed ? '已纳入作战' : '纳入作战并持续跟踪'}
          disabled={held || managed || enrolling}
          aria-busy={enrolling}
          onClick={() => onAdd(opportunity)}
        >
          <Icon
            name={held || managed
              ? 'check'
              : enrolling ? 'refresh' : 'target'}
            size={15}
            className={enrolling ? 'spin' : ''}
          />
        </button>
      </div>
      <details className="aw-edge">
        <summary>模型依据</summary>
        <div>
          <span>
            成交 <b>{probability(estimate.pFill)}</b>
          </span>
          <span>
            胜率 <b>{probability(estimate.pWinGivenFill)}</b>
          </span>
          <span>
            净期望 <b data-positive={Number(estimate.expectedNetR) > 0}>
              {signed(estimate.expectedNetR, 'R')}
            </b>
          </span>
        </div>
      </details>
      <StrategyPatternEvidence
        pattern={opportunity.strategyPattern}
        confirmation={
          opportunity.entryPlan?.strategyPatternConfirmation
        }
      />
      {(adaptive.cautions || []).length > 0 && (
        <p className="aw-caution">
          {adaptive.cautions.slice(0, 2).join('；')}
        </p>
      )}
    </article>
  )
}

function OpportunityBoard({
  book,
  quoteMap,
  onOpen,
  initialSnapshot = null,
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [lane, setLane] = useState(
    initialSnapshot?.defaultLane || '',
  )
  const [enrollingCode, setEnrollingCode] = useState('')
  const [loading, setLoading] = useState(!initialSnapshot)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const budgetKey = JSON.stringify([
    book.account?.cash,
    (book.holding || []).map((item) => [
      item.id,
      item.qty,
      item.sl,
    ]),
    (book.executionPlans || []).map((item) => [
      item.planId,
      item.status,
      item.remainingLots,
    ]),
  ])

  const load = useCallback(async () => {
    try {
      const next = await loadOpportunityRadar()
      setSnapshot(next)
      setLane((current) => current || next.defaultLane || 'intraday')
      setError('')
    } catch (reason) {
      setError(reason?.message || '机会数据暂不可用')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialSnapshot) return undefined
    void load()
    return undefined
  }, [budgetKey, initialSnapshot, load])

  const autoRefreshDelay = opportunityRadarAutoRefreshDelay(
    snapshot,
    Date.now(),
    { refreshing },
  )
  useEffect(() => {
    if (initialSnapshot || autoRefreshDelay == null) return undefined
    const timer = window.setTimeout(() => {
      void load()
    }, autoRefreshDelay)
    return () => window.clearTimeout(timer)
  }, [autoRefreshDelay, initialSnapshot, load])

  const refresh = async () => {
    if (!snapshot || refreshing) return
    setRefreshing(true)
    try {
      const result = await refreshOpportunityRadar({
        lane: lane || snapshot.defaultLane || 'intraday',
        snapshot,
      })
      setSnapshot(result.snapshot)
      setError(result.failed.length ? '部分数据源更新失败，已保留有效结果' : '')
    } catch (reason) {
      setError(reason?.message || '机会扫描失败')
    } finally {
      setRefreshing(false)
    }
  }

  const currentLane = lane || snapshot?.defaultLane || 'intraday'
  const laneRows = snapshot?.lanes?.[currentLane] || []
  const laneSummary = opportunityRadarLaneSummary(laneRows)
  const rows = laneRows
    .filter((item) => item.state !== 'AVOID')
    .slice(0, 5)
  const modelVersionStale = opportunityRadarHasStaleModelSource(
    snapshot,
    currentLane,
  )
  const add = async (opportunity) => {
    if (!opportunity?.code || enrollingCode) return
    setEnrollingCode(opportunity.code)
    planStore.addPlan(
      { code: opportunity.code, name: opportunity.name },
      `${opportunity.adaptive?.playbook?.label || '短线机会'}；`
        + `${opportunity.entryPlan?.trigger || ''}`,
      selectionOriginFromOpportunity(opportunity, snapshot),
    )
    planStore.setAdviceReviewEnabled(opportunity.code, true)
    const current = planStore.get()
    const enrichedQuotes = {
      ...quoteMap,
      [opportunity.code]: {
        ...(quoteMap?.[opportunity.code] || {}),
        code: opportunity.code,
        name: opportunity.name,
        price: quoteMap?.[opportunity.code]?.price
          ?? opportunity.entryPlan?.price
          ?? null,
      },
    }
    try {
      const synced = await planStore.flushSave()
      const result = await tryStartAdvice(buildWatchSpec(
        opportunity.code,
        opportunity.name,
        enrichedQuotes,
        computePortfolio(
          current.holding || [],
          enrichedQuotes,
          current.account,
        ),
        current.account,
      ))
      if (result?.status === 'full') {
        setError('已纳入作战，生成通道正忙，系统将继续排队检查')
      } else if (!synced) {
        setError('已在本机纳入作战，云端设置正在重试同步')
      } else {
        setError('')
      }
    } catch (reason) {
      setError(reason?.message || '已纳入作战，本次生成未启动')
    } finally {
      setEnrollingCode('')
    }
  }
  return (
    <section className="aw-section aw-opportunities" aria-labelledby="aw-opportunities-title">
      <div className="aw-section-head">
        <div>
          <span className="aw-kicker">条件待命</span>
          <h2 id="aw-opportunities-title">等待触发的候选机会</h2>
        </div>
        <div className="aw-board-controls">
          <div className="aw-segmented" role="tablist" aria-label="机会时段">
            {[
              ['intraday', '盘中'],
              ['next', '次日'],
            ].map(([key, label]) => (
              <button
                type="button"
                role="tab"
                aria-selected={currentLane === key}
                className={currentLane === key ? 'active' : ''}
                onClick={() => setLane(key)}
                key={key}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="重新扫描机会"
            title="重新扫描"
            onClick={refresh}
            disabled={refreshing || !snapshot || !!initialSnapshot}
          >
            <Icon
              name="refresh"
              size={15}
              className={refreshing ? 'spin' : ''}
            />
          </button>
        </div>
      </div>
      {(error || modelVersionStale) && (
        <div className="aw-inline-error" role="status">
          {error || '部分机会来自上一模型版本，请重新扫描'}
        </div>
      )}
      {loading && !snapshot ? (
        <div className="aw-loading" role="status">正在计算动作价值…</div>
      ) : rows.length ? (
        <div className="aw-opportunity-list">
          {rows.map((item, index) => (
            <OpportunityRow
              key={item.code}
              opportunity={item}
              rank={index + 1}
              held={(book.holding || []).some(
                (row) => row.code === item.code,
              )}
              managed={
                (book.plan || []).some((row) => row.code === item.code)
                && (
                  !Array.isArray(book.settings?.['advAuto.watchCodes'])
                  || book.settings['advAuto.watchCodes']
                    .includes(item.code)
                )
              }
              enrolling={enrollingCode === item.code}
              onAdd={add}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : (
        <div className="aw-empty">
          <Icon name="radar" size={18} />
          <span>
            {laneSummary.total > 0
              ? `已重算${laneSummary.total}只，全部未达到费后正期望或价格执行条件`
                + (
                  laneSummary.bestExpectedNetR != null
                    ? `；当前最高 ${signed(laneSummary.bestExpectedNetR, 'R')}`
                    : ''
                )
              : '当前没有费后期望为正且价格可执行的机会'}
          </span>
        </div>
      )}
      {snapshot?.opportunityContext && (
        <footer className="aw-board-footer">
          <span>{PHASE_LABELS[snapshot.opportunityContext.phase] || '市场状态待确认'}</span>
          <span>基础单笔风险 {number(snapshot.opportunityContext.baseRiskPct, 2)}%</span>
          <span>通过 {laneSummary.actionable}/{laneSummary.total}</span>
          {snapshot.trainingStatus?.enabled === true ? (
            <span>当前决策模型已启用</span>
          ) : snapshot.trainingStatus?.readiness ? (
            <span title={snapshot.trainingStatus.directEntry?.reason || ''}>
              成熟样本 {snapshot.trainingStatus.readiness.samples}
              /{snapshot.trainingStatus.readiness.requirements.samples}
              {' · '}成交样本 {snapshot.trainingStatus.readiness.filledSamples}
              /{snapshot.trainingStatus.readiness.requirements.filledSamples}
              {' · '}交易日 {snapshot.trainingStatus.readiness.dates}
              /{snapshot.trainingStatus.readiness.requirements.dates}
            </span>
          ) : null}
        </footer>
      )}
    </section>
  )
}

export default function AdaptiveWorkbench({
  market,
  book,
  quotes = [],
  previewSnapshot = null,
}) {
  const quoteMap = useMemo(
    () => Object.fromEntries(
      quotes.filter((item) => item?.code)
        .map((item) => [item.code, item]),
    ),
    [quotes],
  )
  const risk = useMemo(
    () => buildAccountRiskContext(book, quoteMap),
    [book, quoteMap],
  )
  const context = useMemo(
    () => buildMarketOpportunityContext({ market: market || {} }),
    [market],
  )
  const commands = useMemo(
    () => todayCommandList(
      quoteMap,
      Date.now(),
      {
        currentRisk: risk,
        marketRegime: {
          regime: 'ADAPTIVE',
          allowRiskIncrease: true,
        },
      },
    ),
    [book, context, quoteMap, risk],
  )
  const urgentCount = commands.filter(
    (item) => COMMAND_STATES.has(item.state),
  ).length
  const hasActiveObservation = (book.alerts || []).some((item) =>
    item?.reviewOnly === true
    && ['watching', 'reviewing'].includes(item.phase))
  const [clockNow, setClockNow] = useState(Date.now())
  useEffect(() => {
    if (!hasActiveObservation) return undefined
    const timer = window.setInterval(
      () => setClockNow(Date.now()),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [hasActiveObservation])

  return (
    <div className="adaptive-workbench">
      <WorkbenchHeader
        context={context}
        risk={risk}
        commandCount={urgentCount}
      />
      <div className="aw-command-grid">
        <CurrentInstruction
          commands={commands}
          onOpen={openStockDetail}
        />
        <ObservationQueue
          alerts={book.alerts}
          now={clockNow}
          onOpen={openStockDetail}
        />
        <PositionProtection
          book={book}
          quoteMap={quoteMap}
          onOpen={openStockDetail}
        />
      </div>
      <OpportunityBoard
        book={book}
        quoteMap={quoteMap}
        onOpen={openStockDetail}
        initialSnapshot={previewSnapshot}
      />
    </div>
  )
}
