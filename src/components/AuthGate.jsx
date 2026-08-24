import { useState } from 'react'
import Icon from './Icon'
import BrandMark from './BrandMark'
import { authStore, useAuthStore, hasLegacyData } from '../authStore'
import { llmConfigStore } from '../llmConfigStore'
import { quantReportUiStore } from '../quantReportUiStore'
import { quantModelStore } from '../quantModelStore'
import {
  aiSearchConfigStore,
  useAiSearchConfig,
} from '../aiSearchConfigStore'
import { themeStore, useTheme } from '../themeStore'
import ConfirmDialog from './ConfirmDialog'

// ============ 登录/注册门户（未登录时全屏，云端账号）============
export default function AuthGate() {
  const { status, error } = useAuthStore()
  const [tab, setTab] = useState('login') // login | register
  const [nick, setNick] = useState('')
  const [pw, setPw] = useState('')
  const [importLegacy, setImportLegacy] = useState(true)
  const legacy = hasLegacyData()
  const loading = status === 'loading'

  const submit = async () => {
    if (loading) return
    if (tab === 'register') await authStore.register(nick, pw, legacy && importLegacy)
    else await authStore.login(nick, pw)
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={36} />
          <span>短线操盘台</span>
        </div>
        <div className="auth-tabs" aria-label="账号操作">
          <button type="button" className={'auth-tab' + (tab === 'login' ? ' active' : '')} aria-pressed={tab === 'login'} onClick={() => setTab('login')}>登录</button>
          <button type="button" className={'auth-tab' + (tab === 'register' ? ' active' : '')} aria-pressed={tab === 'register'} onClick={() => setTab('register')}>注册</button>
        </div>

        <label className="auth-field">
          <span>昵称</span>
          <input
            className="wl-input auth-input"
            autoComplete="username"
            placeholder="例如：飞飞徐"
            value={nick}
            aria-invalid={status === 'error'}
            aria-describedby={error ? 'auth-error' : undefined}
            onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input
            className="wl-input auth-input"
            type="password"
            autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
            placeholder="输入账号密码"
            value={pw}
            aria-invalid={status === 'error'}
            aria-describedby={error ? 'auth-error' : undefined}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        {tab === 'register' && legacy && (
          <label className="auth-import">
            <input type="checkbox" checked={importLegacy} onChange={(e) => setImportLegacy(e.target.checked)} />
            <span>把本机现有数据(自选/持仓/交易记录)导入此账号</span>
          </label>
        )}

        <div
          id="auth-error"
          className={'auth-helper' + (error ? ' err auth-err' : '')}
          role={error ? 'alert' : 'status'}
        >
          {error || (tab === 'register'
            ? '创建后可在电脑与手机同步持仓、计划和复盘。'
            : '使用已创建的昵称与密码进入工作台。')}
        </div>

        <button type="button" className="btn btn-primary auth-submit" onClick={submit} disabled={loading}>
          <Icon name={loading ? 'refresh' : (tab === 'register' ? 'plus' : 'check')} size={14} className={loading ? 'spin' : ''} />
          {loading ? '处理中…' : (tab === 'register' ? '注册并进入' : '登录')}
        </button>

        <div className="auth-note">
          账号数据保存在阿里云 OSS，换设备用同一昵称+密码登录即可恢复。
          {tab === 'register' && ' 密码可为任意字符，请自行牢记（无法找回）。'}
        </div>
      </div>
    </div>
  )
}

// ============ 顶部账号菜单（已登录，可登出）============
export function AccountMenu() {
  const { user, syncStatus, syncError } = useAuthStore()
  const theme = useTheme()
  const searchConfig = useAiSearchConfig()
  const [open, setOpen] = useState(false)
  const [deactivateOpen, setDeactivateOpen] = useState(false)
  const [deactivateBusy, setDeactivateBusy] = useState(false)
  const [deactivateError, setDeactivateError] = useState('')
  if (!user) return null
  const syncLabel = syncStatus === 'saving'
    ? '正在保存到阿里云 OSS'
    : syncStatus === 'conflict'
      ? '检测到多设备交易冲突，已暂停覆盖'
    : syncStatus === 'error'
      ? 'OSS 同步失败，正在重试'
      : '数据已保存到阿里云 OSS'
  const confirmDeactivate = async () => {
    if (deactivateBusy) return
    setDeactivateBusy(true)
    setDeactivateError('')
    try {
      const result = await authStore.deactivate()
      if (!result?.ok) setDeactivateError(result?.error || '注销失败，请稍后重试')
    } catch (error) {
      setDeactivateError('注销失败：' + String(error?.message || error))
    } finally {
      setDeactivateBusy(false)
    }
  }

  return (
    <div className="acct-wrap">
      <button type="button" className="acct-btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} title="账号">
        <Icon name="user" size={13} /><span>{user}</span><Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <>
          <button type="button" className="acct-mask" aria-label="关闭账号菜单" onClick={() => setOpen(false)} />
          <div className="acct-menu" role="menu">
            <div className="acct-menu-label" title={syncError || ''}>当前账号 · {syncLabel}</div>
            {(syncStatus === 'error' || syncStatus === 'conflict') && (
              <button
                type="button"
                role="menuitem"
                className="acct-item"
                onClick={() => {
                  if (syncStatus !== 'conflict') {
                    void authStore.retrySave()
                    return
                  }
                  const confirmed = window.confirm(
                    '将以本机账本为准，覆盖云端冲突版本。'
                    + '请只在持仓与交易流水正确的设备上继续。',
                  )
                  if (confirmed) void authStore.resolveTradeConflict()
                }}
              >
                <Icon name="refresh" size={13} />
                {syncStatus === 'conflict'
                  ? '以本机交易账本覆盖云端'
                  : '立即重试 OSS 同步'}
              </button>
            )}
            <button type="button" role="menuitem" className="acct-item" onClick={() => { llmConfigStore.open(); setOpen(false) }}>
              <Icon name="brain" size={13} />模型配置
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={searchConfig.enabled}
              className={'acct-item acct-search-toggle' + (searchConfig.enabled ? ' on' : '')}
              disabled={searchConfig.status === 'saving'}
              onClick={async () => {
                const needsKey = !searchConfig.hasKey && !searchConfig.enabled
                await aiSearchConfigStore.toggle()
                if (needsKey) setOpen(false)
              }}
            >
              <Icon name="search" size={13} />
              <span>豆包联网搜索</span>
              <span className="acct-search-state">{searchConfig.enabled ? '开' : '关'}</span>
              <span className="acct-search-track"><span /></span>
            </button>
            <button type="button" role="menuitem" className="acct-item" onClick={() => { aiSearchConfigStore.open(); setOpen(false) }}>
              <Icon name="edit" size={13} />
              {searchConfig.hasKey ? '更换豆包 API Key' : '配置豆包 API Key'}
            </button>
            <button type="button" role="menuitem" className="acct-item" onClick={() => { quantModelStore.open(); setOpen(false) }}>
              <Icon name="activity" size={13} />量化模型配置
            </button>
            <button type="button" role="menuitem" className="acct-item" onClick={() => { quantReportUiStore.open(); setOpen(false) }}>
              <Icon name="gauge" size={13} />量化汇报
            </button>
            <button type="button" role="menuitem" className="acct-item" onClick={() => themeStore.toggle()}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={13} />
              {theme === 'dark' ? '切到浅色模式' : '切到深色模式'}
            </button>
            <button type="button" role="menuitem" className="acct-item" onClick={() => { authStore.logout(); setOpen(false) }}>
              <Icon name="close" size={13} />退出登录
            </button>
            <button
              type="button"
              role="menuitem"
              className="acct-item acct-danger"
              onClick={() => { setOpen(false); setDeactivateError(''); setDeactivateOpen(true) }}
            >
              <Icon name="trash" size={13} />注销账号
            </button>
          </div>
        </>
      )}
      {deactivateOpen && (
        <ConfirmDialog
          title="确认注销账号？"
          body={(
            <div>
              <p>注销后将立即退出，当前账号不能再登录。</p>
              <p><b>账号数据和历史快照不会删除，仍保存在阿里云 OSS，后续可以恢复。</b></p>
              {deactivateError && <p className="err">{deactivateError}</p>}
            </div>
          )}
          confirmText={deactivateBusy ? '注销中…' : '确认注销'}
          confirmIcon="trash"
          confirmDisabled={deactivateBusy}
          onConfirm={confirmDeactivate}
          onCancel={() => { if (!deactivateBusy) setDeactivateOpen(false) }}
        />
      )}
    </div>
  )
}
