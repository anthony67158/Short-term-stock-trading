import { useState, useEffect } from 'react'
import Icon from './Icon'
import AccountTab from './AccountTab'
import ReviewTab from './ReviewTab'
import AlertPanel from './AlertPanel'
import { useAlertStore, alertStore } from '../alertStore'

// ============ 账户·交易 融合页：账户全景 / 预警 / 交易记录 三个子页 ============
export default function AccountHub({ interval, snapshot, initialSub, jumpNonce }) {
  const [sub, setSub] = useState(initialSub || 'account')
  const { unread } = useAlertStore()

  // 外部（导航铃铛）要求跳到预警子页时同步：用自增 nonce 触发，避免同值不刷新
  useEffect(() => { if (jumpNonce) setSub(initialSub || 'alert') }, [jumpNonce])

  // 进入预警子页即标记已读
  useEffect(() => { if (sub === 'alert') alertStore.markAllRead() }, [sub])

  const SUBS = [
    { key: 'account', label: '账户全景', icon: 'gauge' },
    { key: 'alert', label: '盯盘预警', icon: 'bell', badge: unread },
    { key: 'review', label: '交易记录', icon: 'history' },
  ]

  return (
    <div className="hub">
      <nav className="hub-tabs" aria-label="账户闭环">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={'hub-tab' + (sub === s.key ? ' active' : '')}
            aria-current={sub === s.key ? 'page' : undefined}
            onClick={() => setSub(s.key)}
          >
            <Icon name={s.icon} size={15} />
            <span>{s.label}</span>
            {s.badge > 0 && <span className="hub-badge">{s.badge > 9 ? '9+' : s.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="hub-body">
        {sub === 'account' && <AccountTab interval={interval} />}
        {sub === 'alert' && <AlertPanel interval={interval} />}
        {sub === 'review' && <ReviewTab snapshot={snapshot} />}
      </div>
    </div>
  )
}
