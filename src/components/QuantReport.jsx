import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { quantReportStore, useQuantReportStore } from '../quantReportStore'
import { quantReportUiStore } from '../quantReportUiStore'
import { QUANT_REPORT_MODELS, formatQuantMetric, quantReportModel, safeRunUrl } from '../../shared/quantRetrainReport'
import { humanizeUserFacingText } from '../../shared/userFacingLanguage'
import './QuantReport.css'

// ============ 量化每日汇报（独立弹窗，入口在账号下拉菜单，与「AI 模型配置」并列）============

const DECISION_META = {
  promote: { label: '已发布', tone: 'ok' },
  hold: { label: '维持现役', tone: 'neutral' },
  updated: { label: '已更新', tone: 'neutral' },
  shadow: { label: '仅影子发布', tone: 'neutral' },
  reject: { label: '未通过晋级', tone: 'warn' },
  skip: { label: '等待数据', tone: 'neutral' },
  error: { label: '运行异常', tone: 'warn' },
  cancelled: { label: '已取消', tone: 'neutral' },
}

const RUN_META = {
  queued: { label: '排队中', tone: 'running' },
  running: { label: '训练中', tone: 'running' },
  success: { label: '运行成功', tone: 'ok' },
  failed: { label: '运行失败', tone: 'warn' },
  cancelled: { label: '已取消', tone: 'neutral' },
  unknown: { label: '状态未知', tone: 'neutral' },
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  if (!timestamp || !Number.isFinite(date.getTime())) return '未提供'
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(seconds) {
  if (seconds == null) return '未提供'
  const total = Number(seconds)
  if (!Number.isFinite(total)) return '--'
  const minutes = Math.floor(total / 60)
  const remain = Math.round(total % 60)
  return minutes > 0 ? `${minutes}分${remain}秒` : `${remain}秒`
}

function WorkflowStatus({ workflow }) {
  const run =
    workflow?.decision || workflow?.current || workflow?.latest
  if (!run) {
    return (
      <section className="qrp-runtime qrp-runtime-neutral">
        <div className="qrp-runtime-title">
          <Icon name="activity" size={15} />
          <span>决策模型每日训练任务</span>
          <b>状态暂不可用</b>
        </div>
      </section>
    )
  }
  const meta = RUN_META[run.state] || RUN_META.unknown
  return (
    <section className={`qrp-runtime qrp-runtime-${meta.tone}`}>
      <div className="qrp-runtime-title">
        <Icon name={run.state === 'running' ? 'refresh' : 'activity'} size={15} className={run.state === 'running' ? 'spin' : ''} />
        <span>决策模型每日训练任务</span>
        <b>{meta.label}</b>
      </div>
      <div className="qrp-runtime-facts">
        <span>任务 <b>#{run.runNumber || '--'}</b></span>
        <span>启动 <b>{formatTime(run.startedAt)}</b></span>
        <span>耗时 <b>{formatDuration(run.durationSec)}</b></span>
        <span>触发 <b>{run.event === 'schedule' ? '定时' : run.event === 'workflow_dispatch' ? '手动' : '其他'}</b></span>
      </div>
      {safeRunUrl(run.url) && (
        <a className="qrp-runtime-link" href={safeRunUrl(run.url)} target="_blank" rel="noreferrer">
          运行详情
        </a>
      )}
      {workflow?.available === false && <p className="qrp-sync-note">任务状态暂未更新，当前显示上次读取结果</p>}
    </section>
  )
}

function OpportunityStatus({ value }) {
  if (!value) return null
  const count = (number) => number == null || !Number.isFinite(Number(number))
    ? '未提供' : Number(number).toLocaleString('zh-CN')
  const lastRelease = value.lastReleaseDecision
  const releaseLabel = lastRelease?.action === 'PUBLISH'
    ? lastRelease.releaseMode === 'PARTIAL' ? '选择性晋级' : '整包晋级'
    : '维持现役'
  return (
    <section className="qrp-opportunity" aria-label="决策模型当前状态">
      <div className="qrp-section-head"><h3>决策模型当前状态</h3><span>{value.label}</span></div>
      <p className="qrp-conclusion">{value.directUse ? '当前生产模型已启用，只有通过冠军对照与整体风险验证的新组合才会替换它' : value.productionEligible ? '生产模型已就绪' : '尚未切换生产模型'}</p>
      <dl className="qrp-stats">
        <div><dt>生产版本</dt><dd>{value.modelVersion || '未提供'}</dd></div>
        <div><dt>成熟样本</dt><dd>{count(value.samples)}</dd></div>
        <div><dt>完整成交样本</dt><dd>{count(value.filledSamples)}</dd></div>
        <div><dt>独立交易日</dt><dd>{count(value.dates)}</dd></div>
      </dl>
      {lastRelease && (
        <p className="qrp-release-line">
          最近决策 <b>{releaseLabel}</b>
          {lastRelease.promotedComponents?.length > 0 && ` · ${lastRelease.promotedComponents.length} 个组成部分`}
        </p>
      )}
      {value.blockers?.length > 0 && <ul className="qrp-reasons">{value.blockers.map((item) => <li key={item}>{humanizeUserFacingText(item)}</li>)}</ul>}
      <p className="qrp-sync-note">最近记录 {formatTime(value.at)}</p>
    </section>
  )
}

// 把后台生成的多行中文正文解析成结构化字段：每行 "标签：值"。
// 无冒号的行归入 rest，作为整段说明展示，保证任何格式都不丢内容。
function parseBody(body) {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const fields = []
  const rest = []
  for (const line of lines) {
    const m = line.match(/^([^：:]{1,12})[：:]\s*(.+)$/)
    if (m) fields.push({ label: m[1].trim(), value: m[2].trim() })
    else rest.push(line)
  }
  return { fields, rest }
}

function ComponentDecisions({ components }) {
  if (!Array.isArray(components) || components.length === 0) return null
  const statusLabel = {
    IMPROVED: '可晋级',
    BLOCKED: '已拦截',
    UNCHANGED: '无提升',
  }
  return (
    <section className="qrp-components" aria-label="组成部分评估">
      <h4>组成部分评估</h4>
      <div className="qrp-component-list">
        {components.map((item) => (
          <div className="qrp-component" key={item.component || item.label}>
            <div>
              <strong>{item.label || '模型组成'}</strong>
              <span data-status={item.status}>{statusLabel[item.status] || '待核对'}</span>
            </div>
            {[...(item.improvements || []), ...(item.blockers || [])].slice(0, 2).map((line) => (
              <p key={line}>{humanizeUserFacingText(line)}</p>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function RiskThresholds({ thresholds }) {
  const value = thresholds?.overall
  if (!value || typeof value !== 'object') return null
  return (
    <section className="qrp-thresholds" aria-label="整体发布风险阈值">
      <h4>整体发布硬阈值</h4>
      <ul>
        <li>净R下置信界必须大于 {formatQuantMetric(value.lowerBoundMinimum, 'r')}</li>
        <li>Top5费后净R最多下降 {formatQuantMetric(value.meanNetRMaxDrop, 'r')}</li>
        <li>Top5命中率最多下降 {formatQuantMetric(value.precisionMaxDrop, 'percent')}</li>
        <li>最大回撤增幅不得超过 {formatQuantMetric(value.drawdownRelativeIncrease, 'percent')} 或 {formatQuantMetric(value.drawdownAbsoluteIncrease, 'r')}</li>
        <li>千条推理耗时增幅不得超过 {formatQuantMetric(value.inferenceLatencyRelativeIncrease, 'percent')} 且超过 {formatQuantMetric(value.inferenceLatencyAbsoluteIncreaseMsPer1000, 'ms')}</li>
      </ul>
    </section>
  )
}

function ReportCard({ r, busy, expanded }) {
  const meta = DECISION_META[r.decision] || null
  const legacy = parseBody(humanizeUserFacingText(r.body))
  const structured = r.details && typeof r.details === 'object'
  const fields = structured && Array.isArray(r.details.facts) ? r.details.facts : legacy.fields
  const metrics = Array.isArray(r.details?.metrics) ? r.details.metrics : []
  const blockers = Array.isArray(r.details?.blockers) ? r.details.blockers : []
  const components = Array.isArray(r.details?.components) ? r.details.components : []
  const url = safeRunUrl(r.meta?.workflowUrl)
  return (
    <article className={'qrp-card' + (meta ? ' qrp-' + meta.tone : '')} data-model={quantReportModel(r)}>
      <div className="qrp-card-head">
        <h3 className="qrp-card-title">{QUANT_REPORT_MODELS[quantReportModel(r)]}</h3>
        {meta && <span className={'qrp-chip qrp-chip-' + meta.tone}>{meta.label}</span>}
        <button className="qrp-del" title="删除这条汇报" aria-label="删除这条汇报" disabled={busy} onClick={() => quantReportStore.remove(r.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      <div className="qrp-card-meta">
        <time>{formatTime(r.meta?.trainingAt) === '未提供' ? formatTime(r.at) : formatTime(r.meta?.trainingAt)}</time>
        {!!r.meta?.runNumber && <span className="qrp-run">任务 #{r.meta.runNumber}</span>}
        {url && <a href={url} target="_blank" rel="noreferrer">运行详情</a>}
      </div>
      <p className="qrp-summary">{humanizeUserFacingText(r.summary || r.title || '每日重训结果')}</p>
      <details className="qrp-detail" open={expanded}>
        <summary>训练数据与评估依据</summary>
        {fields.length > 0 && (
          <dl className="qrp-fields">
            {fields.map((f, i) => (
              <div className="qrp-row" key={i}>
                <dt className="qrp-label">{humanizeUserFacingText(f.label)}</dt>
                <dd className="qrp-value">{humanizeUserFacingText(f.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {metrics.length > 0 && <table className="qrp-metrics">
          <caption>同一独立盲测集整体评估</caption>
          <thead><tr><th scope="col">指标</th><th scope="col">生产对照</th><th scope="col">本次训练</th><th scope="col">发布组合</th></tr></thead>
          <tbody>{metrics.map((item, index) => <tr key={index}>
            <th scope="row">{item.label}</th>
            <td>{formatQuantMetric(item.champion ?? item.baseline, item.unit)}</td>
            <td>{formatQuantMetric(item.challenger, item.unit)}</td>
            <td>{formatQuantMetric(item.selected, item.unit)}</td>
          </tr>)}</tbody>
        </table>}
        <ComponentDecisions components={components} />
        <RiskThresholds thresholds={r.details?.thresholds} />
        {blockers.length > 0 && <ul className="qrp-reasons">{blockers.map((item, index) => <li key={index}>{humanizeUserFacingText(item)}</li>)}</ul>}
        {!structured && legacy.rest.length > 0 && <div className="qrp-note">{legacy.rest.join('\n')}</div>}
      </details>
    </article>
  )
}

export default function QuantReport() {
  const { reports, workflow, opportunity, loading, mutating, error } = useQuantReportStore()
  const [confirmClear, setConfirmClear] = useState(false)
  const panel = useRef(null)
  const closeButton = useRef(null)
  const onClose = () => quantReportUiStore.close()
  const busy = loading || mutating
  const visibleReports = reports.filter((row) => quantReportModel(row) === 'opportunity')

  useEffect(() => {
    const previous = document.activeElement
    closeButton.current?.focus()
    quantReportStore.load({ force: true })
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') quantReportStore.load({ force: true })
    }, 30000)
    return () => { clearInterval(timer); previous?.focus?.() }
  }, [])

  useEffect(() => {
    const onEscape = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      confirmClear ? setConfirmClear(false) : quantReportUiStore.close()
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [confirmClear])

  function handleKey(event) {
    if (event.key !== 'Tab') return
    const items = [...panel.current.querySelectorAll('button:not(:disabled), a[href], summary')]
      .filter((element) => element.getClientRects().length)
    const first = items[0]
    const last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus()
    }
  }

  return (
    <div className="modal-mask qrp-mask" onClick={onClose} onKeyDown={handleKey}>
      <div ref={panel} className="qrp-panel" role="dialog" aria-modal="true" aria-label="决策模型每日训练与发布" onClick={(e) => e.stopPropagation()}>
        <div className="qrp-bar">
          <h2 className="qrp-heading"><Icon name="gauge" size={18} /> 决策模型每日训练与发布</h2>
          <div className="qrp-actions">
            <button className="qrp-close" title="刷新汇报" aria-label="刷新汇报" disabled={busy} aria-busy={loading} onClick={() => quantReportStore.load({ force: true })}>
              <Icon name="refresh" size={16} />
            </button>
            <button className="qrp-close" title="清空全部汇报" aria-label="清空全部汇报" disabled={busy || !reports.length} onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={16} />
            </button>
            <button ref={closeButton} className="qrp-close" onClick={onClose} title="关闭决策模型训练发布" aria-label="关闭决策模型训练发布"><Icon name="close" size={16} /></button>
          </div>
        </div>

        <div className="qrp-scroll">
          {error && <div className="qrp-error" role="alert">{error}</div>}
          {confirmClear && <section className="qrp-confirm" aria-label="清空汇报确认">
            <p>清空全部决策模型训练与发布历史？此操作无法撤销。</p>
            <div>
              <button className="qrp-btn" disabled={busy} onClick={() => setConfirmClear(false)}>取消</button>
              <button className="qrp-btn" disabled={busy} onClick={async () => {
                if (await quantReportStore.clearAll()) {
                  setConfirmClear(false)
                  closeButton.current?.focus()
                }
              }}><Icon name="trash" size={14} />确认清空</button>
            </div>
          </section>}
          <WorkflowStatus workflow={workflow} />
          <OpportunityStatus value={opportunity} />
          {loading && reports.length === 0 ? (
            <div className="qrp-empty"><Icon name="refresh" size={16} className="spin" /><span>正在加载决策模型训练与发布记录…</span></div>
          ) : error && reports.length === 0 ? (
            <div className="qrp-empty">
              <button className="qrp-btn" disabled={busy} onClick={() => quantReportStore.load({ force: true })}><Icon name="refresh" size={14} />重试</button>
            </div>
          ) : visibleReports.length === 0 ? (
            <div className="qrp-empty">
              <Icon name="gauge" size={22} />
              <span>暂无决策模型训练与发布记录</span>
            </div>
          ) : (
            <>
              <div className="qrp-count" role="status">最近 {visibleReports.length} 条汇报{loading ? ' · 正在更新' : ''}</div>
              <div className="qrp-list">
                {visibleReports.map((r, index) => <ReportCard key={r.id} r={r} busy={busy} expanded={index === 0} />)}
              </div>
            </>
          )}
        </div>

        <div className="qrp-foot">工作日 01:15（北京时间）自动训练 · 仅更优且通过整体风险验证的组成部分会发布</div>
      </div>
    </div>
  )
}
