import { useState, useEffect } from 'react'
import Icon from './Icon'
import { pushSupported, pushStatus, enablePush, disablePush, iosInfo } from '../push'

// ============ 系统级 Web Push 开关（关页面/锁屏也能收到预警）============
// 三种环境:
//   1) 支持(桌面 Chrome/Edge/Firefox、安卓 Chrome、iOS16.4+ 已加主屏幕):显示开/关按钮。
//   2) iOS 未加主屏幕:引导「分享→添加到主屏幕」后再开。
//   3) 完全不支持:提示仅页面打开时可收到浏览器通知。
export default function PushToggle() {
  const [status, setStatus] = useState('checking') // checking|unsupported|denied|off|on
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const { isIOS, standalone } = iosInfo()

  const refresh = async () => { setStatus(await pushStatus()) }
  useEffect(() => { refresh() }, [])

  // iOS Safari 但未以 PWA 打开 → 必须先加主屏幕
  if (isIOS && !standalone && pushSupported() === false) {
    // 某些 iOS 版本非独立态下 PushManager 不存在 → 引导添加到主屏幕
  }

  if (status === 'checking') return null

  // 不支持:iOS 非独立态给专门引导,其余给通用说明
  if (status === 'unsupported') {
    if (isIOS && !standalone) {
      return (
        <div className="push-bar ios">
          <Icon name="info" size={13} />
          <div className="push-txt">
            iPhone 收系统推送需两步：① Safari 点底部<b>「分享」</b>→<b>「添加到主屏幕」</b>；② 从主屏幕图标打开本站后，回到这里开启推送。<span className="sub-name">(需 iOS 16.4 及以上)</span>
          </div>
        </div>
      )
    }
    return (
      <div className="push-bar">
        <Icon name="info" size={13} />
        <div className="push-txt">当前浏览器不支持系统级推送，预警仅在页面打开时通过浏览器通知提醒。</div>
      </div>
    )
  }

  if (status === 'denied') {
    return (
      <div className="push-bar">
        <Icon name="info" size={13} />
        <div className="push-txt">系统通知已被拒绝。请在浏览器/系统设置里为本站放开「通知」权限后重试。</div>
      </div>
    )
  }

  const on = status === 'on'
  const toggle = async () => {
    setBusy(true); setMsg('')
    const r = on ? await disablePush() : await enablePush()
    if (!r.ok) setMsg(r.error || '操作失败')
    await refresh()
    setBusy(false)
  }

  return (
    <div className={'push-bar' + (on ? ' on' : '')}>
      <Icon name="bell" size={13} />
      <div className="push-txt">
        {on
          ? <>系统推送<b>已开启</b>：关页面 / 切后台 / 锁屏也能收到预警。</>
          : <>开启<b>系统推送</b>，关闭页面也能收到买点 / 止盈 / 止损提醒。</>}
        {isIOS && standalone && !on && <span className="sub-name">（已在主屏幕打开，可直接开启）</span>}
        {msg && <span className="push-err">{msg}</span>}
      </div>
      <button className={'btn' + (on ? '' : ' btn-primary')} style={{ marginLeft: 'auto' }} disabled={busy} onClick={toggle}>
        {busy ? '处理中…' : on ? '关闭推送' : '开启推送'}
      </button>
    </div>
  )
}
