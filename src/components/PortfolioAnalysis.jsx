import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import Icon from './Icon'
import { api } from '../apiBase'
import { accountRequestHeaders } from '../quantModel'
import { openStockDetail } from '../detailStore'
import PortfolioExecutionPlan from './PortfolioExecutionPlan'
import {
  buildPortfolioAdviceBrief,
} from '../../shared/portfolioAdviceBrief.js'
import {
  humanizeAdviceTextFields,
} from '../../shared/userFacingLanguage.js'

const PHASE_LABELS = {
  account: '账户重算',
  market: '市场环境',
  quant: '量化核验',
  search: '联网检索',
  tools: '工具复核',
  diagnosis: '结构诊断',
  complete: '结论整理',
}

const ACTION_LABELS = {
  reduce: '减持',
  hold: '持有',
  watch: '观察',
  exit: '退出',
  add: '增加',
  increase: '增加',
}

function percent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '--'
}

function money(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(number)
}

function dateTime(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '--'
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function AnalysisHistory({
  items = [],
  selectedId = '',
  loadingId = '',
  onSelect,
  onLatest,
}) {
  if (!items.length) return null
  return (
    <details className="portfolio-analysis-history">
      <summary>
        <Icon name="history" size={13} />
        分析记录
        <span>{items.length}</span>
      </summary>
      <div className="portfolio-analysis-history-list">
        {items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={
              selectedId
                ? selectedId === item.id
                : index === 0
            }
            onClick={() => index === 0
              ? onLatest()
              : onSelect(item.id)}
          >
            <span>
              <b>{item.headline || '持仓组合诊断'}</b>
              <small>
                {item.source === 'review' ? '自动复核' : '手动分析'}
                {' · '}
                {dateTime(item.generatedAt)}
              </small>
            </span>
            <strong>
              {loadingId === item.id
                ? '读取中'
                : item.score == null ? '--' : `${item.score}分`}
            </strong>
          </button>
        ))}
      </div>
    </details>
  )
}

function DecisionPath({ nodes = [] }) {
  if (!nodes.length) return null
  return (
    <div className="portfolio-analysis-path">
      <div className="portfolio-analysis-section-title">
        <Icon name="layers" size={13} /> 关键决策节点
      </div>
      <ol>
        {nodes.map((node, index) => (
          <li key={`${node.key || node.title}-${index}`} data-status={node.status || 'watch'}>
            <span className="portfolio-analysis-node-mark">{index + 1}</span>
            <div>
              <b>{node.title}</b>
              <p>{node.conclusion}</p>
              {node.evidenceIds?.length > 0 && (
                <small>{node.evidenceIds.join(' · ')}</small>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function EvidenceList({ evidence = [] }) {
  if (!evidence.length) return null
  return (
    <details className="portfolio-analysis-evidence">
      <summary>
        <Icon name="book" size={13} /> 证据账本
        <span>{evidence.length}</span>
      </summary>
      <div>
        {evidence.map((item) => (
          <article key={item.id}>
            <span className={item.trusted ? 'trusted' : 'reference'}>{item.id}</span>
            <div>
              <b>{item.title}</b>
              <p>{item.summary}</p>
              <small>{item.source}{item.asOf ? ` · ${String(item.asOf).slice(0, 19)}` : ''}</small>
            </div>
            {item.url && (
              <a href={item.url} target="_blank" rel="noreferrer" aria-label={`打开${item.title}来源`}>
                <Icon name="chevronRight" size={13} />
              </a>
            )}
          </article>
        ))}
      </div>
    </details>
  )
}

function CategoryTargets({ targets = {} }) {
  const rows = [
    ['核心仓', targets.corePct],
    ['标准仓', targets.standardPct],
    ['卫星仓', targets.satellitePct],
  ]
  return (
    <div className="portfolio-analysis-categories">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <div><i style={{ width: `${Math.max(0, Math.min(100, Number(value) || 0))}%` }} /></div>
          <b>{percent(value)}</b>
        </div>
      ))}
    </div>
  )
}

function PortfolioAdviceBrief({ brief }) {
  return (
    <section className="portfolio-advice-brief" aria-label="持仓操作摘要">
      <div className="portfolio-advice-conclusion">
        <div className="portfolio-advice-label">
          <Icon name="target" size={13} /> 操作结论
        </div>
        <h3>{brief.conclusion}</h3>
        <p><b>逻辑：</b>{brief.logic}</p>
        {brief.projectedPositionPct != null && (
          <span>执行后仓位 <b>{percent(brief.projectedPositionPct)}</b></span>
        )}
      </div>

      {brief.actions.length > 0 && (
        <div className="portfolio-advice-actions">
          {brief.actions.map((item) => (
            <button
              type="button"
              key={`${item.action}-${item.code}`}
              data-action={item.action}
              onClick={() => openStockDetail(item.code, item.name)}
            >
              <span
                className="portfolio-advice-action-label"
                data-action={item.action}
              >
                {item.actionLabel}
              </span>
              <span className="portfolio-advice-action-stock">
                <b>{item.name}</b>
                <small>{item.code}{item.concept ? ` · ${item.concept}` : ''}</small>
              </span>
              <span className="portfolio-advice-action-order">
                {item.lots > 0 && <b>{item.lots}手</b>}
                {item.referencePrice != null && (
                  <small>@ {item.referencePrice}</small>
                )}
                {item.amount != null && <small>{money(item.amount)}</small>}
              </span>
              <span className="portfolio-advice-action-reason">
                {item.reason || '按组合目标执行'}
              </span>
              <Icon name="chevronRight" size={13} />
            </button>
          ))}
        </div>
      )}

      <div className="portfolio-advice-recommendations">
        <div className="portfolio-advice-label">
          <Icon name="compass" size={13} /> 推荐股票
        </div>
        {brief.recommendations.length > 0 ? (
          <div>
            {brief.recommendations.map((item) => (
              <button
                type="button"
                key={item.code}
                onClick={() => openStockDetail(item.code, item.name)}
              >
                <span>
                  <b>{item.name}</b>
                  <small>{item.code}{item.concept ? ` · ${item.concept}` : ''}</small>
                </span>
                <p><strong>推荐原因：</strong>{item.reason}</p>
                <Icon name="chevronRight" size={13} />
              </button>
            ))}
          </div>
        ) : (
          <p className="portfolio-advice-empty">
            {brief.noRecommendationText}
          </p>
        )}
      </div>
    </section>
  )
}

function AnalysisResult({ result }) {
  const displayResult = humanizeAdviceTextFields(result || {})
  const analysis = displayResult.analysis || {}
  const allocation = analysis.allocation || {}
  const assessment = analysis.positionAssessment || {}
  const hasExecutionPlan = !!analysis.executionPlan?.todayGoal
  const brief = buildPortfolioAdviceBrief(analysis)
  return (
    <div className="portfolio-analysis-result">
      <PortfolioAdviceBrief brief={brief} />
      {displayResult.warning && (
        <div
          className={
            'portfolio-analysis-warning'
            + (displayResult.meta?.modelRecovered ? ' recovered' : '')
          }
          role="status"
        >
          <Icon
            name={displayResult.meta?.modelRecovered ? 'check' : 'info'}
            size={13}
          />
          <span>{displayResult.warning}</span>
        </div>
      )}

      <details className="portfolio-analysis-details">
        <summary>
          <span>
            <Icon name="layers" size={13} />
            展开详细分析
          </span>
          <small>仓位逻辑、完整执行单、风险与证据</small>
          <Icon name="chevronDown" size={13} />
        </summary>
        <div className="portfolio-analysis-details-body">
          <div className="portfolio-analysis-verdict">
            <div className="portfolio-analysis-score">
              <strong>{assessment.score ?? '--'}</strong>
              <span>仓位健康分</span>
            </div>
            <div>
              <span className="portfolio-analysis-level">{assessment.level || '待观察'}</span>
              <h3>{analysis.headline}</h3>
              <p>{assessment.rationale}</p>
            </div>
          </div>

          <PortfolioExecutionPlan analysis={analysis} />

          <div className="portfolio-analysis-grid">
            <section>
              <div className="portfolio-analysis-section-title">
                <Icon name="gauge" size={13} /> 目标仓位
              </div>
              <div className="portfolio-analysis-kpis">
                <span>当前<b>{percent(displayResult.snapshot?.positionPct)}</b></span>
                <span>目标<b>{percent(allocation.targetPositionPct)}</b></span>
                <span>现金<b>{percent(allocation.targetCashReservePct)}</b></span>
              </div>
              <CategoryTargets targets={allocation.categoryTargets} />
              {allocation.cashStrategy && (
                <p className="portfolio-analysis-note">{allocation.cashStrategy}</p>
              )}
              {analysis.concentration?.note && (
                <p className="portfolio-analysis-note">
                  <b>集中度：</b>{analysis.concentration.note}
                </p>
              )}
            </section>

            <section>
              <div className="portfolio-analysis-section-title">
                <Icon name="activity" size={13} /> 动态调仓机制
              </div>
              <ul className="portfolio-analysis-rules">
                {(allocation.dynamicRules || []).map((rule, index) => (
                  <li key={index}>{rule}</li>
                ))}
              </ul>
              {(allocation.adjustments || []).map((item, index) => (
                <div className="portfolio-analysis-adjustment" key={`${item.target}-${index}`}>
                  <span>{item.target}</span>
                  <b data-action={item.action}>
                    {ACTION_LABELS[item.action] || '维持'} {percent(item.changePct)}
                  </b>
                  <p>{item.reason}</p>
                </div>
              ))}
            </section>
          </div>

          {!hasExecutionPlan && analysis.stockActions?.length > 0 && (
            <section className="portfolio-analysis-section">
              <div className="portfolio-analysis-section-title">
                <Icon name="shield" size={13} /> 个股调整
              </div>
              <div className="portfolio-analysis-actions">
                {analysis.stockActions.map((item) => (
                  <button
                    type="button"
                    key={item.code}
                    onClick={() => openStockDetail(item.code, item.name)}
                  >
                    <span>
                      <b>{item.name}</b>
                      <small>{item.code} · {ACTION_LABELS[item.action] || item.action}</small>
                    </span>
                    <span>
                      <p>{item.reason}</p>
                      {(Number(item.reducePct) > 0 || Number(item.targetWeightPct) > 0) && (
                        <small>
                          {Number(item.reducePct) > 0 ? `建议减持 ${percent(item.reducePct)}` : ''}
                          {Number(item.reducePct) > 0 && Number(item.targetWeightPct) > 0 ? ' · ' : ''}
                          {Number(item.targetWeightPct) > 0 ? `目标占比 ${percent(item.targetWeightPct)}` : ''}
                        </small>
                      )}
                      {item.trigger && <small>触发：{item.trigger}</small>}
                    </span>
                    <Icon name="chevronRight" size={14} />
                  </button>
                ))}
              </div>
            </section>
          )}

          {!hasExecutionPlan && analysis.recommendations?.length > 0 && (
            <section className="portfolio-analysis-section">
              <div className="portfolio-analysis-section-title">
                <Icon name="compass" size={13} /> 活跃方向候选
              </div>
              <div className="portfolio-analysis-recommendations">
                {analysis.recommendations.map((item) => (
                  <button
                    type="button"
                    key={item.code}
                    onClick={() => openStockDetail(item.code, item.name)}
                  >
                    <span>{item.concept}</span>
                    <b>{item.name} <small>{item.code}</small></b>
                    <p>{item.reason}</p>
                    <small>关注条件：{item.trigger || '等待量价确认'} · 上限 {percent(item.maxWeightPct)}</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          {analysis.risks?.length > 0 && (
            <section className="portfolio-analysis-risks">
              <div className="portfolio-analysis-section-title">
                <Icon name="info" size={13} /> 风险与失效条件
              </div>
              <ul>
                {analysis.risks.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </section>
          )}

          <DecisionPath nodes={displayResult.decisionNodes} />
          <EvidenceList evidence={displayResult.evidence} />
          <div className="portfolio-analysis-meta">
            <span>{displayResult.meta?.model || '规则降级'}</span>
            {displayResult.meta?.endpoint && <span>{displayResult.meta.endpoint}</span>}
            {displayResult.meta?.quantModelLabel && <span>{displayResult.meta.quantModelLabel}</span>}
            <span>{displayResult.generatedAt ? new Date(displayResult.generatedAt).toLocaleString('zh-CN') : ''}</span>
          </div>
        </div>
      </details>
    </div>
  )
}

export default function PortfolioAnalysis({ distribution }) {
  const [deepMode, setDeepMode] = useState(true)
  const [state, setState] = useState({
    loading: false,
    jobStatus: 'idle',
    phase: '',
    phases: [],
    evidence: [],
    decisions: [],
    result: null,
    latestResult: null,
    history: [],
    selectedHistoryId: '',
    historyLoadingId: '',
    review: {
      enabled: false,
      nextReviewAt: 0,
      reviewCount: 0,
    },
    reviewBusy: false,
    error: '',
    notice: '',
  })
  const pollKickRef = useRef(null)

  const applyStatus = useCallback((data) => {
    const job = data?.job
    const loading = ['queued', 'running'].includes(job?.status)
    const latestResult = data?.latest?.result
      || (job?.status === 'done' ? job.result : null)
    setState((current) => ({
      ...current,
      loading,
      jobStatus: job?.status || 'idle',
      phase: job?.phase || '',
      phases: Array.isArray(job?.phases) ? job.phases : [],
      evidence: Array.isArray(job?.evidence) ? job.evidence : [],
      decisions: Array.isArray(job?.decisions) ? job.decisions : [],
      latestResult: latestResult || current.latestResult,
      result: current.selectedHistoryId
        ? current.result
        : latestResult || current.result,
      history: Array.isArray(data?.history)
        ? data.history
        : current.history,
      review: data?.review && typeof data.review === 'object'
        ? data.review
        : current.review,
      error: job?.status === 'failed'
        ? job.error || '后台诊断失败'
        : '',
      notice: loading
        ? '已转入后台运行，关闭或刷新页面不会中断'
        : '',
    }))
    return loading
  }, [])

  const request = useCallback(async (payload, timeoutMs = 12000) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(api('/api/portfolio_analysis'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...accountRequestHeaders(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      return {
        response,
        data,
      }
    } finally {
      clearTimeout(timer)
    }
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const { response, data } = await request(
        { op: 'status' },
        9000,
      )
      if (!response.ok || !data?.ok) return false
      return applyStatus(data)
    } catch {
      return false
    }
  }, [applyStatus, request])

  useEffect(() => {
    let disposed = false
    let timer = null
    const schedule = (delay) => {
      if (disposed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, delay)
    }
    const tick = async () => {
      const active = await fetchStatus()
      schedule(active ? 2000 : 15000)
    }
    pollKickRef.current = () => schedule(0)
    schedule(0)
    return () => {
      disposed = true
      pollKickRef.current = null
      if (timer) clearTimeout(timer)
    }
  }, [fetchStatus])

  const generate = async (refresh = false) => {
    if (state.loading || !distribution?.stocks?.length) return
    setState((current) => ({
      ...current,
      loading: true,
      jobStatus: 'queued',
      phase: '正在提交后台任务',
      phases: [],
      evidence: [],
      decisions: [],
      selectedHistoryId: '',
      result: current.latestResult || current.result,
      error: '',
      notice: '正在提交，受理后可安全关闭页面',
    }))
    try {
      const { response, data } = await request({
        op: 'start',
        deepMode,
        refresh,
      }, 18000)
      if (data?.job) applyStatus(data)
      if (!data?.accepted && (!response.ok || !data?.ok)) {
        throw new Error(
          data?.error || `后台诊断提交失败（${response.status}）`,
        )
      }
      if (data?.queued && data?.error) {
        setState((current) => ({
          ...current,
          notice: data.error,
        }))
      }
      pollKickRef.current?.()
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        jobStatus: 'failed',
        error: error?.name === 'AbortError'
          ? '提交后台任务超时，请重试'
          : error?.message || '后台诊断提交失败',
        notice: '',
      }))
    }
  }

  const toggleReview = async (enabled) => {
    if (state.reviewBusy) return
    setState((current) => ({
      ...current,
      reviewBusy: true,
      error: '',
    }))
    try {
      const { response, data } = await request({
        op: 'setReview',
        enabled,
      })
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || '复核设置保存失败')
      }
      setState((current) => ({
        ...current,
        review: data.review,
        reviewBusy: false,
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        reviewBusy: false,
        error: error?.message || '复核设置保存失败',
      }))
    }
  }

  const showLatest = () => {
    setState((current) => ({
      ...current,
      selectedHistoryId: '',
      result: current.latestResult || current.result,
    }))
  }

  const loadHistory = async (historyId) => {
    if (!historyId || state.historyLoadingId) return
    setState((current) => ({
      ...current,
      historyLoadingId: historyId,
      error: '',
    }))
    try {
      const { response, data } = await request({
        op: 'history',
        historyId,
      })
      if (!response.ok || !data?.entry?.result) {
        throw new Error(data?.error || '历史诊断读取失败')
      }
      setState((current) => ({
        ...current,
        selectedHistoryId: historyId,
        historyLoadingId: '',
        result: data.entry.result,
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        historyLoadingId: '',
        error: error?.message || '历史诊断读取失败',
      }))
    }
  }

  const reviewCaption = state.review?.enabled
    ? [
        Number(state.review.reviewCount) > 0
          ? `已复核${state.review.reviewCount}次`
          : '',
        state.review.nextReviewAt
          ? `下次 ${dateTime(state.review.nextReviewAt)}`
          : '等待首次分析',
      ].filter(Boolean).join(' · ')
    : '已关闭'

  return (
    <section className="portfolio-analysis" aria-label="仓位与仓位类别AI诊断">
      <div className="portfolio-analysis-head">
        <div>
          <div role="heading" aria-level="3" className="portfolio-analysis-title">
            <Icon name="brain" size={15} /> 仓位诊断
          </div>
          <span>{distribution?.positionPct?.toFixed?.(1) || '0.0'}% 仓位 · {distribution?.groups?.length || 0} 个核心概念</span>
        </div>
        <div className="portfolio-analysis-controls">
          <label
            className="portfolio-analysis-review-toggle"
            title="开启后按交易账本变化或每60分钟自动复核"
          >
            <input
              type="checkbox"
              role="switch"
              aria-label="自动复核"
              checked={state.review?.enabled === true}
              onChange={(event) => toggleReview(event.target.checked)}
              disabled={
                state.reviewBusy
                || state.jobStatus === 'queued'
              }
            />
            <span className="portfolio-analysis-switch" aria-hidden="true">
              <i />
            </span>
            <span>
              <b>自动复核</b>
              <small>{reviewCaption}</small>
            </span>
          </label>
          <label className="portfolio-analysis-mode">
            <input
              type="checkbox"
              checked={deepMode}
              onChange={(event) => setDeepMode(event.target.checked)}
              disabled={state.loading}
            />
            <span>深度分析</span>
          </label>
          {state.loading ? (
            <button type="button" className="btn" disabled>
              <Icon name="refresh" size={12} className="spin" />
              后台生成中
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.reviewBusy}
              onClick={() => generate(Boolean(state.result))}
            >
              <Icon name={state.result ? 'refresh' : 'spark'} size={13} />
              {state.result ? '重新诊断' : '开始诊断'}
            </button>
          )}
        </div>
      </div>

      {state.loading && (
        <div className="portfolio-analysis-progress" aria-live="polite">
          <div className="portfolio-analysis-background-status">
            <Icon name="layers" size={13} />
            <span>{state.notice}</span>
          </div>
          <div className="portfolio-analysis-phase-list">
            {state.phases.map((phase) => (
              <span key={phase.key}>
                <Icon name="check" size={11} />
                {PHASE_LABELS[phase.key] || phase.text}
              </span>
            ))}
            <span className="active">
              <Icon name="refresh" size={11} className="spin" />
              {state.phase || '正在准备服务端账户快照'}
            </span>
          </div>
          <DecisionPath nodes={state.decisions} />
          <EvidenceList evidence={state.evidence} />
        </div>
      )}

      {!state.loading && !state.result && !state.error && (
        <div className="portfolio-analysis-idle">
          <span>当前仓位</span><b>{percent(distribution?.positionPct)}</b>
          <span>现金预留</span><b>{percent(distribution?.cashReservePct)}</b>
          <span>仓位类别</span><b>{distribution?.categories?.filter((item) => item.stockCount > 0).length || 0}</b>
        </div>
      )}

      {state.error && (
        <div className="portfolio-analysis-error" role="alert">
          <Icon name="info" size={13} />
          <span>{state.error}</span>
          <button type="button" className="btn" onClick={() => generate(true)}>重试</button>
        </div>
      )}

      <AnalysisHistory
        items={state.history}
        selectedId={state.selectedHistoryId}
        loadingId={state.historyLoadingId}
        onSelect={loadHistory}
        onLatest={showLatest}
      />

      {state.result && <AnalysisResult result={state.result} />}
    </section>
  )
}
