import { useEffect, useRef, useState } from 'react'
import {
  aiSearchConfigStore,
  useAiSearchConfig,
} from '../aiSearchConfigStore'
import Icon from './Icon'

export default function AISearchConfig() {
  const config = useAiSearchConfig()
  const [apiKey, setApiKey] = useState('')
  const inputRef = useRef(null)
  const busy = config.status === 'saving' || config.status === 'loading'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const save = async () => {
    const result = await aiSearchConfigStore.save({
      enabled: config.hasKey ? config.enabled : true,
      apiKey,
    })
    if (result.ok) setApiKey('')
  }

  return (
    <div
      className="modal-mask"
      onClick={(event) => {
        if (event.target === event.currentTarget) aiSearchConfigStore.close()
      }}
    >
      <div
        className="search-cfg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-config-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-bar">
          <div className="modal-title" id="search-config-title">
            <Icon name="search" size={18} /> AI消息检索
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭AI消息检索设置"
            onClick={() => aiSearchConfigStore.close()}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="search-cfg-status">
          <div>
            <b>检索服务</b>
            <span>{config.enabled ? '生成时引用检索参考' : '所有AI生成排除检索数据'}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.enabled}
            className={'search-switch' + (config.enabled ? ' on' : '')}
            disabled={busy || (!config.hasKey && !config.enabled)}
            onClick={() => aiSearchConfigStore.toggle()}
          >
            <span className="search-switch-label">{config.enabled ? '开启' : '关闭'}</span>
            <span className="search-switch-track"><span /></span>
          </button>
        </div>

        <label className="search-cfg-field" htmlFor="ai-search-key">
          <span>API Key</span>
          <input
            ref={inputRef}
            id="ai-search-key"
            className="wl-input auth-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={config.hasKey
              ? `已保存（${config.apiKeyMask}），留空则保留`
              : 'sk-...'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) void save()
            }}
          />
        </label>

        <div className="search-cfg-policy">
          <span>个股缓存 <b>{config.cachePolicy.stockMinutes} 分钟</b></span>
          <span>行业缓存 <b>{config.cachePolicy.industryMinutes} 分钟</b></span>
          <span>自动复核 <b>仅用缓存</b></span>
        </div>

        <div className="search-cfg-message" role={config.error ? 'alert' : 'status'}>
          {config.error || config.notice || 'Key 仅保存在服务端 OSS，前端不会回显明文。'}
        </div>

        <div className="search-cfg-actions">
          <button
            type="button"
            className="btn"
            onClick={() => aiSearchConfigStore.close()}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!apiKey && config.hasKey)}
            onClick={save}
          >
            <Icon name={busy ? 'refresh' : 'check'} size={14} className={busy ? 'spin' : ''} />
            {busy ? '保存中…' : (config.hasKey ? '更换 Key' : '保存并启用')}
          </button>
        </div>
      </div>
    </div>
  )
}
