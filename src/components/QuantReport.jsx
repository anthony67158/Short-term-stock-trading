import { useEffect } from 'react'
import Icon from './Icon'
import { quantReportStore, useQuantReportStore } from '../quantReportStore'
import { quantReportUiStore } from '../quantReportUiStore'

// ============ 量化每日汇报（独立弹窗，入口在账号下拉菜单，与「AI 模型配置」并列）============

const DECISION_META = {
  promote: { label: '晋级', tone: 'ok' },
  reject: { label: '拒绝', tone: 'neutral' },
  error: { label: '异常', tone: 'warn' },
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

function ReportCard({ r }) {
  const meta = DECISION_META[r.decision] || null
  const { fields, rest } = parseBody(r.body)
  const time = new Date(r.at).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  return (
    <div className={'qrp-card' + (meta ? ' qrp-' + meta.tone : '')}>
      <div className="qrp-card-head">
        <span className="qrp-card-title">量化每日重训</span>
        {meta && <span className={'qrp-chip qrp-chip-' + meta.tone}>{meta.label}</span>}
        <span className="qrp-time">{time}</span>
        <button className="qrp-del" title="删除这条汇报" onClick={() => quantReportStore.remove(r.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {fields.length > 0 && (
        <dl className="qrp-fields">
          {fields.map((f, i) => (
            <div className="qrp-row" key={i}>
              <dt className="qrp-label">{f.label}</dt>
              <dd className="qrp-value">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {rest.length > 0 && <div className="qrp-note">{rest.join('\n')}</div>}
    </div>
  )
}

export default function QuantReport() {
  const { reports, loading, error } = useQuantReportStore()
  const onClose = () => quantReportUiStore.close()

  // 打开即拉取每日汇报（后台定时任务写入 OSS）
  useEffect(() => { quantReportStore.load() }, [])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="qrp-panel" role="dialog" aria-modal="true" aria-label="量化汇报" onClick={(e) => e.stopPropagation()}>
        <div className="qrp-bar">
          <div className="qrp-heading"><Icon name="gauge" size={18} /> 量化汇报</div>
          <div className="qrp-actions">
            {reports.length > 0 && (
              <>
                <button className="qrp-btn" onClick={() => quantReportStore.load({ force: true })}>
                  <Icon name="refresh" size={13} /> 刷新
                </button>
                <button className="qrp-btn" onClick={() => quantReportStore.clearAll()}>
                  <Icon name="trash" size={13} /> 清空
                </button>
              </>
            )}
            <button className="qrp-close" onClick={onClose} title="关闭"><Icon name="close" size={16} /></button>
          </div>
        </div>

        <div className="qrp-scroll">
          {loading && reports.length === 0 ? (
            <div className="qrp-empty"><Icon name="refresh" size={16} className="spin" /><span>正在加载量化每日汇报…</span></div>
          ) : error && reports.length === 0 ? (
            <div className="qrp-empty">
              <span>加载失败：{error}</span>
              <button className="qrp-btn" style={{ marginTop: 10 }} onClick={() => quantReportStore.load({ force: true })}>重试</button>
            </div>
          ) : reports.length === 0 ? (
            <div className="qrp-empty">
              <Icon name="gauge" size={22} />
              <span>暂无量化汇报</span>
              <p className="qrp-empty-sub">每天凌晨持续训练跑完后，会把当天的中文决策汇报（晋级 / 拒绝、样本外 AUC 对比、样本量、耗时）推送到这里。</p>
            </div>
          ) : (
            <>
              <div className="qrp-count">共 {reports.length} 条汇报</div>
              <div className="qrp-list">
                {reports.map((r) => <ReportCard key={r.id} r={r} />)}
              </div>
            </>
          )}
        </div>

        <div className="qrp-foot">汇报由每日持续训练定时任务生成，仅供研究参考，非投资建议</div>
      </div>
    </div>
  )
}
