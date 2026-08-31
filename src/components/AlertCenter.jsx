import { useState, useEffect, useMemo } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import ActionQuickExec from './ActionQuickExec'
import { usePolling } from '../hooks'
import { fmtRaw } from '../format'
import { openStockDetail } from '../detailStore'
import { planStore, t1StatusOf, usePlanStore } from '../planStore'
import { alertStore, useAlertStore, describeAlert, alertMeta } from '../alertStore'
import { quantReportStore, useQuantReportStore } from '../quantReportStore'
import { userFacingAlertMessage } from '../../shared/alertNotification.js'
import { applyT1ToAlert } from '../../shared/t1AdvicePolicy.js'

// ============ 预警中心：站内通知流 + 预警规则管理 + 量化每日汇报 ============
export default function AlertCenter({ onClose }) {
  const [tab, setTab] = useState('notif') // notif 通知 | rules 规则 | quant 量化
  const { notifications, permission } = useAlertStore()
  const { reports, loading: qLoading, error: qError } = useQuantReportStore()
  const book = usePlanStore()
  const alerts = book.alerts || []

  // 打开即标记已读
  useState(() => { alertStore.markAllRead(); return 0 })
  // 切到「量化」页时拉取每日汇报（后台定时任务写入 OSS）
  useEffect(() => { if (tab === 'quant') quantReportStore.load() }, [tab])

  // 规则页:轮询相关个股实时报价,用于「距触发」可视化
  const ruleCodes = useMemo(() => [...new Set(alerts.map((a) => a.code))], [alerts])
  const { data: quoteData } = usePolling(
    tab === 'rules' && ruleCodes.length ? `/api/quote?codes=${ruleCodes.join(',')}` : null,
    15000, [tab, ruleCodes.join(',')]
  )
  const quote = {}
  ;(quoteData?.list || []).forEach((s) => { quote[s.code] = s })

  const enableNotif = async () => { await alertStore.requestPermission() }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="alert-center" role="dialog" aria-modal="true" aria-label="预警中心" onClick={(e) => e.stopPropagation()}>
        <div className="modal-bar">
          <div className="modal-title"><Icon name="bell" size={17} /> 预警中心</div>
          <button type="button" className="modal-close" aria-label="关闭预警中心" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="tabs" style={{ margin: '4px 16px 0' }}>
          <button type="button" className={'tab' + (tab === 'notif' ? ' active' : '')} aria-pressed={tab === 'notif'} onClick={() => setTab('notif')}>通知 {notifications.length > 0 && `(${notifications.length})`}</button>
          <button type="button" className={'tab' + (tab === 'rules' ? ' active' : '')} aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>规则 {alerts.length > 0 && `(${alerts.length})`}</button>
          <button type="button" className={'tab' + (tab === 'quant' ? ' active' : '')} aria-pressed={tab === 'quant'} onClick={() => setTab('quant')}>量化汇报 {reports.length > 0 && `(${reports.length})`}</button>
        </div>

        {/* 通知授权提示 */}
        {permission !== 'granted' && (
          <div className="alert-perm">
            <Icon name="info" size={13} /> 开启浏览器通知，切后台也能收到预警提醒
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={enableNotif}>开启通知</button>
          </div>
        )}

        <div className="alert-body">
          {tab === 'notif' && (
            notifications.length === 0 ? (
              <div className="empty-state">
                <span className="es-icon"><Icon name="bell" size={20} /></span>
                <div className="es-title">暂无预警通知</div>
                <div className="es-desc">在自选/持仓或个股详情里设置预警规则，命中时会在这里提醒你。</div>
              </div>
            ) : (
              <>
                <div className="alert-toolbar">
                  <span className="sub-name">{notifications.length} 条通知</span>
                  <button className="btn" onClick={() => alertStore.clearAll()}><Icon name="trash" size={12} /> 清空</button>
                </div>
                {notifications.map((n) => (
                  <button type="button" className={'alert-notif' + (n.code ? ' an-clickable' : '')} key={n.id}
                    onClick={n.code ? () => openStockDetail(n.code, n.name) : undefined}
                    disabled={!n.code}
                    title={n.code ? '点击查看个股详情与K线' : undefined}>
                    <div className="an-dot" />
                    <div className="an-main">
                      <div className="an-title">
                        <StockName
                          code={n.code}
                          name={n.name || n.code}
                          interactive={false}
                        />
                        {n.code && <span className="an-jump"><Icon name="chevronRight" size={12} /></span>}
                      </div>
                      <div className="an-body">{n.body}</div>
                      <div className="an-time">{new Date(n.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  </button>
                ))}
              </>
            )
          )}
          {tab === 'rules' && (
            alerts.length === 0 ? (
              <div className="empty-state">
                <span className="es-icon"><Icon name="bell" size={20} /></span>
                <div className="es-title">还没有预警规则</div>
                <div className="es-desc">在「持仓·做T」的自选/持仓卡片，或个股详情弹窗里点「设预警」即可添加。生成操作建议时也会自动挂上补仓/减仓行动预警。</div>
              </div>
            ) : (
              alerts.map((a) => {
                const q = quote[a.code]
                const m = alertMeta(a, q)
                const t1View = applyT1ToAlert(a, t1StatusOf(a.code))
                const showTrack = !a.triggeredAt && m.progress != null
                return (
                <div className={'alert-rule dir-' + m.dir + (a.enabled ? '' : ' off') + (m.near ? ' is-near' : '')} key={a.id}>
                  <button type="button" className="ar-main ar-main-clickable" onClick={() => openStockDetail(a.code, a.name)} title="点击查看个股详情与K线">
                    <div className="ar-name">
                      <StockName
                        code={a.code}
                        name={a.name || a.code}
                        interactive={false}
                      />
                      <span className="ar-dir">{m.dirLabel}</span>
                      {Number(a.judgeCount) > 0 && (
                        <span className="ar-badge judge">
                          军师已复核 {Number(a.judgeCount)} 次
                        </span>
                      )}
                      {a.lastKnowledgeAction?.total != null && (
                        <span className="ar-badge knowledge">
                          知行合一 {a.lastKnowledgeAction.total} · {a.lastKnowledgeAction.grade}
                        </span>
                      )}
                      {t1View.t1Blocked && <span className="ar-badge t1">T+1锁定 · 今日不可卖</span>}
                      {q && <span className="ar-now">现 {fmtRaw(q.price)}</span>}
                      <span className="ar-jump" title="查看详情与K线"><Icon name="chevronRight" size={13} /></span>
                    </div>
                    <div className="ar-desc">{describeAlert(a)}{a.note && !a.actKind ? ` · ${a.note}` : ''}</div>
                    {a.lastKnowledgeAction && (
                      <div className="ar-desc">
                        {a.lastKnowledgeAction.missing?.length
                          ? `待补：${a.lastKnowledgeAction.missing.join('、')}`
                          : '交易逻辑、触发、仓位、退出与失效条件已形成闭环'}
                      </div>
                    )}
                    {showTrack && (
                      <>
                        <div className="ar-track"><div className="ar-track-fill" style={{ width: m.progress + '%' }} /></div>
                        <div className="ar-dist-row">
                          {m.near ? <span className="ar-dir ar-near">接近触发</span> : null}
                          <span className="ar-dist-val">{m.distPct <= 0 ? '已到触发价' : `距触发还差 ${m.distPct.toFixed(2)}%`}</span>
                          <span className="ar-dist-target">目标 <b>{fmtRaw(a.value)}</b></span>
                        </div>
                      </>
                    )}
                    {a.triggeredAt && <div className="ar-fired">已于 {new Date(a.triggeredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 触发：{userFacingAlertMessage(a)}</div>}
                  </button>
                  <div className="ar-actions">
                    {a.actKind && <ActionQuickExec alert={a} holding={book.holding} />}
                    {a.triggeredAt ? (
                      <button className="chip-btn ghost" title="重新启用" onClick={() => planStore.rearmAlert(a.id)}><Icon name="refresh" size={12} />重启</button>
                    ) : (
                      <button className={'ar-toggle' + (a.enabled ? ' on' : '')} title={a.enabled ? '点击停用' : '点击启用'} onClick={() => planStore.toggleAlert(a.id)}>
                        {a.enabled ? '启用中' : '已停用'}
                      </button>
                    )}
                    <button className="icon-btn" title="删除规则" onClick={() => planStore.removeAlert(a.id)}><Icon name="trash" size={13} /></button>
                  </div>
                </div>
                )
              })
            )
          )}
          {tab === 'quant' && (
            qLoading && reports.length === 0 ? (
              <div className="skel-list">
                {[0, 1, 2].map((i) => (
                  <div className="skel-report" key={i}>
                    <div className="skel-dot skel" />
                    <div className="sk-body">
                      <div className="skel-line w1 skel" style={{ width: '46%' }} />
                      <div className="skel-line skel" style={{ width: '88%' }} />
                      <div className="skel-line sm skel" style={{ width: '64%' }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : qError && reports.length === 0 ? (
              <div className="empty-state">
                <span className="es-icon"><Icon name="info" size={20} /></span>
                <div className="es-title">加载失败</div>
                <div className="es-desc">{qError}</div>
                <button className="btn es-cta" onClick={() => quantReportStore.load({ force: true })}><Icon name="refresh" size={12} /> 重试</button>
              </div>
            ) : reports.length === 0 ? (
              <div className="empty-state">
                <span className="es-icon"><Icon name="chart" size={20} /></span>
                <div className="es-title">暂无量化汇报</div>
                <div className="es-desc">每天凌晨持续训练跑完后，会把当天的中文决策汇报（晋级/拒绝、样本外 AUC 对比、样本量、耗时）推送到这里。</div>
              </div>
            ) : (
              <>
                <div className="alert-toolbar">
                  <span className="sub-name">{reports.length} 条汇报</span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                    <button className="btn" onClick={() => quantReportStore.load({ force: true })}><Icon name="refresh" size={12} /> 刷新</button>
                    <button className="btn" onClick={() => quantReportStore.clearAll()}><Icon name="trash" size={12} /> 清空</button>
                  </span>
                </div>
                {reports.map((r) => (
                  <div className={'alert-notif qr-item' + (r.decision ? ' qr-' + r.decision : '')} key={r.id}>
                    <div className="an-dot" />
                    <div className="an-main">
                      <div className="an-title">
                        <span>{r.title || '量化每日重训汇报'}</span>
                        {r.decision && <span className={'qr-tag qr-tag-' + r.decision}>{r.decision === 'promote' ? '晋级' : r.decision === 'reject' ? '拒绝' : '异常'}</span>}
                      </div>
                      <div className="an-body qr-body">{r.body}</div>
                      <div className="an-time">{new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                    <button className="icon-btn" title="删除这条汇报" onClick={() => quantReportStore.remove(r.id)}><Icon name="trash" size={13} /></button>
                  </div>
                ))}
              </>
            )
          )}
        </div>
        <div className="ai-disclaimer" style={{ padding: '8px 16px 12px' }}>
          预警基于实时行情轮询（交易时段约15秒/次），命中后自动停用防重复；仅供研究参考，非投资建议
        </div>
      </div>
    </div>
  )
}

// ---- 通用：设预警的小表单（内嵌在自选/持仓/详情里用）----
export function AlertForm({ stock, onDone }) {
  const [type, setType] = useState('price')
  const [op, setOp] = useState('gte')
  const [value, setValue] = useState('')
  const needValueOp = type === 'price' || type === 'pct' || type === 'vol' || type === 'turnover'

  const submit = () => {
    if (needValueOp && !(Number(value) || value === '0')) return
    planStore.addAlert({
      code: stock.code, name: stock.name, type,
      op: needValueOp ? op : 'gte',
      value: needValueOp ? Number(value) : null,
    })
    onDone && onDone()
  }

  return (
    <div className="alert-form">
      <div className="af-row">
        <select className="wl-select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="price">到价</option>
          <option value="pct">涨跌幅</option>
          <option value="vol">量比</option>
          <option value="turnover">换手率</option>
          <option value="limitup">临近涨停</option>
          <option value="limitdown">临近跌停</option>
        </select>
        {needValueOp && (
          <>
            <select className="wl-select" value={op} onChange={(e) => setOp(e.target.value)}>
              <option value="gte">≥</option>
              <option value="lte">≤</option>
            </select>
            <input className="wl-input" style={{ width: 80 }} value={value} onChange={(e) => setValue(e.target.value)}
              placeholder={type === 'price' ? '价格' : type === 'pct' ? '%' : '数值'} inputMode="decimal" />
          </>
        )}
        <button className="chip-btn done" onClick={submit}><Icon name="check" size={12} />设预警</button>
      </div>
    </div>
  )
}
