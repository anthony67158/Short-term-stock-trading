import { useState, useMemo } from 'react'
import Icon from './Icon'
import StockName from './StockName'
import ConfirmDialog from './ConfirmDialog'
import ActionQuickExec from './ActionQuickExec'
import { openStockDetail } from '../detailStore'
import { usePolling } from '../hooks'
import { planStore, t1StatusOf, usePlanStore } from '../planStore'
import { alertStore, useAlertStore, describeAlert, alertMeta, ALERT_TYPES } from '../alertStore'
import { fmtRaw } from '../format'
import PushToggle from './PushToggle'
import { judgeEffectStats } from '../../shared/confirmPolicy.js'
import { applyT1ToAlert } from '../../shared/t1AdvicePolicy.js'
import { formatPriceLimitThreshold } from '../../shared/priceLimitPolicy.js'

// ============ 盯盘预警（内嵌面板，非弹窗）：规则管理 + 通知历史 ============
export default function AlertPanel({ interval }) {
  const book = usePlanStore()
  const { notifications, permission } = useAlertStore()
  const [tab, setTab] = useState('rules') // rules 规则 | notif 通知
  const [adding, setAdding] = useState(false)
  const [delTarget, setDelTarget] = useState(null)
  const [delBatch, setDelBatch] = useState(null)
  const alerts = book.alerts || []
  const visibleAlerts = alerts.filter((alert) => alert.phase !== 'superseded')
  const activeCnt = visibleAlerts.filter((a) => a.enabled && !a.triggeredAt).length
  // 分组:手动预警 vs AI 自动预警(planId=持仓止盈止损 / candCode=自选买点 / actCode=补仓减仓行动点)
  const manualAlerts = visibleAlerts.filter((a) => !a.planId && !a.candCode && !a.actCode)
  const autoAlerts = visibleAlerts.filter((a) => a.planId || a.candCode || a.actCode)
  const triggeredAlerts = visibleAlerts.filter((a) => a.triggeredAt)
  const aiAutoOn = (book.settings || {}).aiAutoAlert !== false
  const smartConfirmOn = (book.settings || {}).smartConfirm !== false
  const judgeStats = judgeEffectStats([...alerts, ...(book.decisionLog || [])])
  const knowledgeActionStats = useMemo(() => {
    const scores = [
      ...alerts.map((item) => item?.lastKnowledgeAction?.total),
      ...(book.decisionLog || [])
        .filter((item) => item?.kind === 'judge')
        .map((item) => item?.knowledgeAction?.total),
    ].map(Number).filter(Number.isFinite)
    return {
      total: scores.length,
      average: scores.length
        ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
        : null,
    }
  }, [alerts, book.decisionLog])

  // 候选：自选 + 持仓（去重），供新增预警选择
  const cands = useMemo(() => {
    const m = new Map()
    ;[...book.plan, ...book.holding].forEach((x) => { if (!m.has(x.code)) m.set(x.code, { code: x.code, name: x.name }) })
    return [...m.values()]
  }, [book.plan, book.holding])
  const codes = cands.map((c) => c.code)
  const { data } = usePolling(codes.length ? `/api/quote?codes=${codes.join(',')}` : null, interval, [codes.join(',')])
  const quote = {}
  ;(data?.list || []).forEach((s) => { quote[s.code] = s })

  return (
    <div className="panel">
      <div className="panel-head">
        <div role="heading" aria-level="2" className="panel-title"><Icon name="bell" size={16} /> 盯盘预警
          <span className="sub-name">{activeCnt} 条监控中 · 命中即弹通知+响铃</span>
        </div>
        <button className="btn btn-primary" onClick={async () => { await alertStore.requestPermission(); setAdding((v) => !v) }} disabled={cands.length === 0}>
          <Icon name="plus" size={13} /> 新增预警
        </button>
      </div>

      {/* 通知权限提示 */}
      {permission !== 'granted' && (
        <div className="alert-perm">
          <Icon name="info" size={13} /> 开启浏览器通知，切后台也能收到预警提醒
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => alertStore.requestPermission()}>开启通知</button>
        </div>
      )}

      {/* 系统级 Web Push：关页面/锁屏也能收到（含 iOS 引导） */}
      <PushToggle />

      <div className="judge-effect">
        <div>
          <span className="judge-effect-k">军师执行确认</span>
          <b>{judgeStats.evaluated ? `${judgeStats.winRate}%` : '样本积累中'}</b>
        </div>
        <div>
          <span className="judge-effect-k">知行合一</span>
          <b>{knowledgeActionStats.average != null ? `${knowledgeActionStats.average}分` : '待评估'}</b>
        </div>
        <span>
          已触达 {judgeStats.confirmed} 次 · 已复核 {judgeStats.evaluated} 次
          {judgeStats.avgDirectionalPct != null
            ? ` · 平均方向收益 ${judgeStats.avgDirectionalPct >= 0 ? '+' : ''}${judgeStats.avgDirectionalPct}%`
            : ' · 强提示后自动跟踪5/15/30分钟'}
        </span>
      </div>

      {/* 新增预警表单 */}
      {adding && (
        <div className="alert-add-wrap">
          {cands.length === 0
            ? <div className="empty small">先在「今日选股/持仓」加自选或建仓，才能给它设预警。</div>
            : <NewAlertForm cands={cands} quote={quote} onDone={() => setAdding(false)} />}
        </div>
      )}

      <div className="tabs" style={{ margin: '4px 18px 8px' }}>
        <button type="button" className={'tab' + (tab === 'rules' ? ' active' : '')} aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>规则 {visibleAlerts.length > 0 && `(${visibleAlerts.length})`}</button>
        <button type="button" className={'tab' + (tab === 'notif' ? ' active' : '')} aria-pressed={tab === 'notif'} onClick={() => setTab('notif')}>命中记录 {notifications.length > 0 && `(${notifications.length})`}</button>
      </div>

      <div className="alert-body-inline">
        {tab === 'rules' ? (
          visibleAlerts.length === 0 ? (
            <div className="empty">还没有预警规则。点右上「新增预警」，或在自选/持仓卡片、个股详情里点「设预警」添加。</div>
          ) : (
            <>
              {/* 批量工具条:一键清理已触发规则 + AI 自动预警总开关 */}
              <div className="alert-toolbar">
                <label className="ai-auto-switch" title="关闭后不再自动生成买点/止盈/止损预警,已有的自动预警会被清除">
                  <input type="checkbox" checked={aiAutoOn} onChange={(e) => planStore.setAiAutoAlert(e.target.checked)} />
                  <span>AI 自动预警</span>
                </label>
                <label className="ai-auto-switch" title="开启后:价位预警到点先发弱提醒(观察确认中),系统盯盘确认真正时机后再发「可以买入/卖出」强提示。关闭则见价即强提示。">
                  <input type="checkbox" checked={smartConfirmOn} onChange={(e) => planStore.setSmartConfirm(e.target.checked)} />
                  <span>智能时机确认</span>
                </label>
                {triggeredAlerts.length > 0 && (
                  <button className="btn" style={{ marginLeft: 'auto' }}
                    onClick={() => setDelBatch({ ids: triggeredAlerts.map((a) => a.id), label: `${triggeredAlerts.length} 条已触发规则` })}>
                    <Icon name="trash" size={12} /> 清理已触发({triggeredAlerts.length})
                  </button>
                )}
              </div>

              {/* AI 自动预警(可整组清空) */}
              {autoAlerts.length > 0 && (
                <div className="alert-group">
                  <div className="alert-group-head">
                    <span className="sub-name">AI 自动预警 · {autoAlerts.length} 条(跟随军师建议自动维护)</span>
                    <button className="btn tiny" onClick={() => setDelBatch({ ids: autoAlerts.map((a) => a.id), label: `全部 ${autoAlerts.length} 条 AI 自动预警` })}>
                      <Icon name="trash" size={11} /> 全部删除
                    </button>
                  </div>
                  {autoAlerts.map((a) => renderRule(a, quote, setDelTarget, book.holding))}
                </div>
              )}

              {/* 手动预警 */}
              {manualAlerts.length > 0 && (
                <div className="alert-group">
                  <div className="alert-group-head"><span className="sub-name">手动预警 · {manualAlerts.length} 条</span></div>
                  {manualAlerts.map((a) => renderRule(a, quote, setDelTarget, book.holding))}
                </div>
              )}
            </>
          )
        ) : (
          notifications.length === 0 ? (
            <div className="empty">暂无命中记录。预警触发后会在这里留档。</div>
          ) : (
            <>
              <div className="alert-toolbar">
                <span className="sub-name">{notifications.length} 条命中</span>
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
        )}
      </div>

      <div className="ai-disclaimer" style={{ padding: '8px 18px 12px' }}>
        预警基于实时行情轮询（交易时段约15秒/次），命中后自动停用防重复；仅供研究参考，非投资建议
      </div>

      {delTarget && (
        <ConfirmDialog
          title="删除此预警？"
          body={<>确定删除 <b>{delTarget.name}</b> 的「{describeAlert(delTarget)}」预警？{(delTarget.planId || delTarget.candCode || delTarget.actCode) && <><br /><span className="sub-name">这是 AI 自动预警，删除后不会再被自动加回（除非在该股「恢复自动预警」）。</span></>}</>}
          confirmText="删除"
          onConfirm={() => { planStore.removeAlert(delTarget.id); setDelTarget(null) }}
          onCancel={() => setDelTarget(null)}
        />
      )}
      {delBatch && (
        <ConfirmDialog
          title="批量删除预警？"
          body={<>确定删除 <b>{delBatch.label}</b>？<br /><span className="sub-name">其中的 AI 自动预警删除后不会再被自动加回。</span></>}
          confirmText="删除"
          onConfirm={() => { planStore.removeAlerts(delBatch.ids); setDelBatch(null) }}
          onCancel={() => setDelBatch(null)}
        />
      )}
    </div>
  )
}

// 单条预警规则行（手动/AI 自动共用）
function renderRule(a, quote, setDelTarget, holding) {
  const t1View = applyT1ToAlert(a, t1StatusOf(a.code))
  const isAuto = !!(a.planId || a.candCode || a.actCode)
  const q = quote[a.code]
  const m = alertMeta(a, q)
  const showTrack = !a.triggeredAt && m.progress != null   // 仅未触发的价位类显示距触发进度
  return (
    <div className={'alert-rule dir-' + m.dir + (a.enabled ? '' : ' off') + (m.near ? ' is-near' : '')} key={a.id}>
      <button type="button" className="ar-main ar-main-clickable" onClick={() => openStockDetail(a.code, a.name)} title="点击查看个股详情与K线">
        <div className="ar-name">
          <span>{a.name || a.code}</span>
          <span className="ar-code">{a.code}</span>
          <span className="ar-dir">{m.dirLabel}</span>
          {isAuto && <span className="ar-badge">AI</span>}
          {t1View.t1Blocked && <span className="ar-badge t1">T+1锁定 · 今日不可卖</span>}
          {a.phase === 'watching' && <span className="ar-badge watching">观察确认中</span>}
          {q && <span className="ar-now">现 {fmtRaw(q.price)}</span>}
          <span className="ar-jump" title="查看详情与K线"><Icon name="chevronRight" size={13} /></span>
        </div>
        <div className="ar-desc">{describeAlert(a)}{a.note && !a.actKind ? ` · ${a.note}` : ''}</div>
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
        {a.phase === 'watching' && !a.triggeredAt && (
          <div className="ar-watching"><Icon name="eye" size={12} /> 已到点位，系统盯盘确认真正时机中，确认后会发「可以操作」强提示{a.watchingAt ? ` · ${new Date(a.watchingAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}起` : ''}</div>
        )}
        {a.triggeredAt && <div className="ar-fired">已于 {new Date(a.triggeredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} 触发：{a.triggeredMsg}</div>}
      </button>
      <div className="ar-actions">
        {a.actKind && <ActionQuickExec alert={a} holding={holding} />}
        {a.triggeredAt ? (
          <button className="chip-btn ghost" title="重新启用" onClick={() => planStore.rearmAlert(a.id)}><Icon name="refresh" size={12} />重启</button>
        ) : (
          <button className={'ar-toggle' + (a.enabled ? ' on' : '')} title={a.enabled ? '点击停用' : '点击启用'} onClick={() => planStore.toggleAlert(a.id)}>
            {a.enabled ? '启用中' : '已停用'}
          </button>
        )}
        <button className="icon-btn" title="删除规则" onClick={() => setDelTarget(a)}><Icon name="trash" size={13} /></button>
      </div>
    </div>
  )
}

// 新增预警表单（在预警面板内选股票+条件）
function NewAlertForm({ cands, quote, onDone }) {
  const [code, setCode] = useState(cands[0]?.code || '')
  const [type, setType] = useState('price')
  const [op, setOp] = useState('gte')
  const [value, setValue] = useState('')
  const typeDef = ALERT_TYPES.find((t) => t.key === type) || {}
  const picked = cands.find((c) => c.code === code)
  const q = quote[code]

  const submit = () => {
    if (!picked) return
    if (typeDef.needValue && !(Number(value) || value === '0')) return
    planStore.addAlert({
      code, name: picked.name, type,
      op: typeDef.needOp ? op : 'gte',
      value: typeDef.needValue ? Number(value) : null,
    })
    onDone()
  }

  return (
    <div className="alert-form">
      <div className="af-row">
        <label>股票</label>
        <select className="wl-select" value={code} onChange={(e) => setCode(e.target.value)}>
          {cands.map((c) => <option key={c.code} value={c.code}>{c.name} {c.code}</option>)}
        </select>
        {q && <span className="af-now">现价 {fmtRaw(q.price)} · {q.pct >= 0 ? '+' : ''}{q.pct}%</span>}
      </div>
      <div className="af-row">
        <label>条件</label>
        <select className="wl-select" value={type} onChange={(e) => setType(e.target.value)}>
          {ALERT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        {typeDef.needOp && (
          <select className="wl-select" value={op} onChange={(e) => setOp(e.target.value)}>
            <option value="gte">≥</option>
            <option value="lte">≤</option>
          </select>
        )}
        {typeDef.needValue && (
          <input className="wl-input" style={{ width: 90 }} value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={'阈值' + (typeDef.unit ? '(' + typeDef.unit + ')' : '')} inputMode="decimal" />
        )}
        {!typeDef.needValue && (
          <span className="af-hint">
            {type === 'limitup' ? '涨幅' : '跌幅'}≥
            {formatPriceLimitThreshold({ code, name: picked?.name }, true)}% 提醒
          </span>
        )}
      </div>
      <div className="af-actions">
        <button className="chip-btn done" onClick={submit}><Icon name="check" size={12} />添加预警</button>
        <button className="chip-btn ghost" onClick={onDone}>取消</button>
      </div>
    </div>
  )
}
