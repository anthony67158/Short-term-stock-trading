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
  const run = workflow?.current || workflow?.latest
  if (!run) {
    return (
      <section className="qrp-runtime qrp-runtime-neutral">
        <div className="qrp-runtime-title">
          <Icon name="activity" size={15} />
          <span>每日重训任务</span>
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
        <span>每日重训任务</span>
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
  return (
    <section className="qrp-opportunity" aria-label="V3 当前状态">
      <div className="qrp-section-head"><h3>V3 当前状态</h3><span>{value.label}</span></div>
      <p className="qrp-conclusion">{value.directUse ? '当前V3已启用，评测记录不限制使用' : value.productionEligible ? '生产模型已就绪' : '尚未切换生产模型'}</p>
      <dl className="qrp-stats">
        <div><dt>成熟样本</dt><dd>{count(value.samples)}</dd></div>
        <div><dt>完整成交样本</dt><dd>{count(value.filledSamples)}</dd></div>
        <div><dt>独立交易日</dt><dd>{count(value.dates)}</dd></div>
      </dl>
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

function ReportCard({ r, busy, expanded }) {
  const meta = DECISION_META[r.decision] || null
  const legacy = parseBody(humanizeUserFacingText(r.body))
  const structured = r.details && typeof r.details === 'object'
  const fields = structured && Array.isArray(r.details.facts) ? r.details.facts : legacy.fields
  const metrics = Array.isArray(r.details?.metrics) ? r.details.metrics : []
  const blockers = Array.isArray(r.details?.blockers) ? r.details.blockers : []
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
          <caption>样本外评估</caption>
          <thead><tr><th scope="col">指标</th><th scope="col">本次候选</th><th scope="col">对照</th></tr></thead>
          <tbody>{metrics.map((item, index) => <tr key={index}>
            <th scope="row">{item.label}</th>
            <td>{formatQuantMetric(item.challenger, item.unit)}</td>
            <td>{formatQuantMetric(item.baseline, item.unit)}</td>
          </tr>)}</tbody>
        </table>}
        {blockers.length > 0 && <ul className="qrp-reasons">{blockers.map((item, index) => <li key={index}>{humanizeUserFacingText(item)}</li>)}</ul>}
        {!structured && legacy.rest.length > 0 && <div className="qrp-note">{legacy.rest.join('\n')}</div>}
      </details>
    </article>
  )
}

export default function QuantReport() {
  const { reports, workflow, opportunity, loading, mutating, error } = useQuantReportStore()
  const [model, setModel] = useState('all')
  const [confirmClear, setConfirmClear] = useState(false)
  const panel = useRef(null)
  const closeButton = useRef(null)
  const onClose = () => quantReportUiStore.close()
  const busy = loading || mutating
  const visibleReports = reports.filter((row) => model === 'all' || quantReportModel(row) === model)

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
      <div ref={panel} className="qrp-panel" role="dialog" aria-modal="true" aria-label="量化汇报" onClick={(e) => e.stopPropagation()}>
        <div className="qrp-bar">
          <h2 className="qrp-heading"><Icon name="gauge" size={18} /> 量化汇报</h2>
          <div className="qrp-actions">
            <button className="qrp-close" title="刷新汇报" aria-label="刷新汇报" disabled={busy} aria-busy={loading} onClick={() => quantReportStore.load({ force: true })}>
              <Icon name="refresh" size={16} />
            </button>
            <button className="qrp-close" title="清空全部汇报" aria-label="清空全部汇报" disabled={busy || !reports.length} onClick={() => setConfirmClear(true)}>
              <Icon name="trash" size={16} />
            </button>
            <button ref={closeButton} className="qrp-close" onClick={onClose} title="关闭量化汇报" aria-label="关闭量化汇报"><Icon name="close" size={16} /></button>
          </div>
        </div>

        <div className="qrp-scroll">
          {error && <div className="qrp-error" role="alert">{error}</div>}
          {confirmClear && <section className="qrp-confirm" aria-label="清空汇报确认">
            <p>清空全部模型的历史汇报？此操作无法撤销。</p>
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
          <div className="qrp-filters" role="group" aria-label="模型筛选">
            {Object.entries({ all: '全部', ...QUANT_REPORT_MODELS }).map(([key, label]) => (
              <button key={key} aria-pressed={model === key} onClick={() => setModel(key)}>{label}</button>
            ))}
          </div>
          {loading && reports.length === 0 ? (
            <div className="qrp-empty"><Icon name="refresh" size={16} className="spin" /><span>正在加载量化每日汇报…</span></div>
          ) : error && reports.length === 0 ? (
            <div className="qrp-empty">
              <button className="qrp-btn" disabled={busy} onClick={() => quantReportStore.load({ force: true })}><Icon name="refresh" size={14} />重试</button>
            </div>
          ) : visibleReports.length === 0 ? (
            <div className="qrp-empty">
              <Icon name="gauge" size={22} />
              <span>{model === 'all' ? '暂无量化汇报' : `${QUANT_REPORT_MODELS[model]}暂无历史汇报`}</span>
            </div>
          ) : (
            <>
              <div className="qrp-count" role="status">最近 {visibleReports.length} 条汇报{loading ? ' · 正在更新' : ''}</div>
              <div className="qrp-list">
                {visibleReports.map((r, index) => <ReportCard key={`${model}:${r.id}`} r={r} busy={busy} expanded={index === 0} />)}
              </div>
            </>
          )}
        </div>

        <div className="qrp-foot">工作日 01:15（北京时间）计划重训 · 样本外评估不代表实盘收益</div>
      </div>
    </div>
  )
}
