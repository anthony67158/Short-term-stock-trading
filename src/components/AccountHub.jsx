import { useEffect } from 'react'
import Icon from './Icon'
import ReviewTab from './ReviewTab'
import AlertPanel from './AlertPanel'
import { useAlertStore, alertStore } from '../alertStore'

// 资金与仓位在交易工作区；本页只保留复盘和预警记录。
export default function AccountHub({
  interval,
  snapshot,
  sub = 'review',
  onSubChange,
}) {
  const { unread } = useAlertStore()

  // 进入预警子页即标记已读
  useEffect(() => { if (sub === 'alert') alertStore.markAllRead() }, [sub])

  const SUBS = [
    { key: 'review', label: '交易复盘', icon: 'history' },
    { key: 'alert', label: '预警记录', icon: 'bell', badge: unread },
  ]

  return (
    <div className="hub">
      <nav className="hub-tabs" aria-label="复盘与改进">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={'hub-tab' + (sub === s.key ? ' active' : '')}
            aria-current={sub === s.key ? 'page' : undefined}
            onClick={() => onSubChange?.(s.key)}
          >
            <Icon name={s.icon} size={15} />
            <span>{s.label}</span>
            {s.badge > 0 && <span className="hub-badge">{s.badge > 9 ? '9+' : s.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="hub-body">
        {sub === 'alert' && <AlertPanel interval={interval} />}
        {sub === 'review' && <ReviewTab snapshot={snapshot} />}
      </div>
    </div>
  )
}
