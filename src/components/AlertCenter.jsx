import { useState } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import { planStore, usePlanStore } from '../planStore'
import { alertStore, useAlertStore, describeAlert } from '../alertStore'

// ============ 预警中心：站内通知流 + 预警规则管理 ============
export default function AlertCenter({ onClose }) {
  const [tab, setTab] = useState('notif') // notif 通知 | rules 规则
  const { notifications, permission } = useAlertStore()
  const book = usePlanStore()
  const alerts = book.alerts || []

  // 打开即标记已读
  useState(() => { alertStore.markAllRead(); return 0 })

  const enableNotif = async () => { await alertStore.requestPermission() }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="alert-center" onClick={(e) => e.stopPropagation()}>
        <div className="modal-bar">
          <div className="modal-title"><Icon name="bell" size={17} /> 预警中心</div>
          <div className="modal-close" onClick={onClose}><Icon name="close" size={16} /></div>
        </div>

        <div className="tabs" style={{ margin: '4px 16px 0' }}>
          <div className={'tab' + (tab === 'notif' ? ' active' : '')} onClick={() => setTab('notif')}>通知 {notifications.length > 0 && `(${notifications.length})`}</div>
          <div className={'tab' + (tab === 'rules' ? ' active' : '')} onClick={() => setTab('rules')}>规则 {alerts.length > 0 && `(${alerts.length})`}</div>
        </div>

        {/* 通知授权提示 */}
        {permission !== 'granted' && (
          <div className="alert-perm">
            <Icon name="info" size={13} /> 开启浏览器通知，切后台也能收到预警提醒
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={enableNotif}>开启通知</button>
          </div>
        )}

        <div className="alert-body">
          {tab === 'notif' ? (
            notifications.length === 0 ? (
              <div className="empty">暂无预警通知。在自选/持仓或个股详情里设置预警规则，命中时会在这里提醒你。</div>
            ) : (
              <>
                <div className="alert-toolbar">
                  <span className="sub-name">{notifications.length} 条通知</span>
                  <button className="btn" onClick={() => alertStore.clearAll()}><Icon name="trash" size={12} /> 清空</button>
                </div>
                {notifications.map((n) => (
                  <div className="alert-notif" key={n.id}>
                    <div className="an-dot" />
                    <div className="an-main">
                      <div className="an-title"><StockName code={n.code} name={n.name} stopPropagation><span>{n.name || n.code}</span></StockName></div>
                      <div className="an-body">{n.body}</div>
                      <div className="an-time">{new Date(n.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  </div>
                ))}
              </>
            )
          ) : (
            alerts.length === 0 ? (
              <div className="empty">还没有预警规则。在「持仓·做T」的自选/持仓卡片，或个股详情弹窗里点「设预警」即可添加。</div>
            ) : (
              alerts.map((a) => (
                <div className={'alert-rule' + (a.enabled ? '' : ' off')} key={a.id}>
                  <div className="ar-main">
                    <div className="ar-name">
                      <StockName code={a.code} name={a.name} stopPropagation><span>{a.name || a.code}</span></StockName>
                      <span className="ar-code">{a.code}</span>
                    </div>
                    <div className="ar-desc">{describeAlert(a)}{a.note ? ` · ${a.note}` : ''}</div>
                    {a.triggeredAt && <div className="ar-fired">已于 {new Date(a.triggeredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 触发：{a.triggeredMsg}</div>}
                  </div>
                  <div className="ar-actions">
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
              ))
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
