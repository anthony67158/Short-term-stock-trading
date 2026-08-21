import { useState } from 'react'
import Icon from './Icon'
import { sectorForecastRequest } from '../sectorForecastClient.js'

export default function SectorForecastSettings({
  initial,
  onClose,
  onSaved,
}) {
  const [draft, setDraft] = useState(() => ({
    autoEnabled: initial?.autoEnabled !== false,
    closeTime: initial?.closeTime || '15:10',
    overnightEnabled: initial?.overnightEnabled !== false,
    overnightTime: initial?.overnightTime || '08:50',
    intradayEnabled: initial?.intradayEnabled !== false,
    intradayIntervalMinutes:
      Number(initial?.intradayIntervalMinutes) || 5,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const response = await sectorForecastRequest({
        action: 'save_settings',
        method: 'POST',
        body: { settings: draft },
      })
      onSaved?.(response.settings)
      onClose?.()
    } catch (reason) {
      setError(reason?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="sector-forecast-settings" onSubmit={submit}>
      <div className="sector-setting-list">
        <div
          className="sector-setting-row"
          data-enabled={draft.autoEnabled}
        >
          <button
            type="button"
            role="switch"
            aria-checked={draft.autoEnabled}
            aria-label="自动收盘生成正式排名"
            className={'sector-setting-switch' + (
              draft.autoEnabled ? ' on' : ''
            )}
            onClick={() => setDraft((current) => ({
              ...current,
              autoEnabled: !current.autoEnabled,
            }))}
          >
            <span><i /></span>
          </button>
          <div className="sector-setting-name">
            <Icon name="history" size={15} />
            <strong>收盘生成正式排名</strong>
          </div>
          <label className="sector-setting-control">
            <span>执行时间</span>
          <input
            type="time"
            aria-label="收盘生成执行时间"
            min="15:05"
            max="23:59"
            value={draft.closeTime}
            disabled={!draft.autoEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              closeTime: event.target.value,
            }))}
          />
          </label>
        </div>
        <div
          className="sector-setting-row"
          data-enabled={draft.overnightEnabled}
        >
          <button
            type="button"
            role="switch"
            aria-checked={draft.overnightEnabled}
            aria-label="自动盘前更新隔夜证据"
            className={'sector-setting-switch' + (
              draft.overnightEnabled ? ' on' : ''
            )}
            onClick={() => setDraft((current) => ({
              ...current,
              overnightEnabled: !current.overnightEnabled,
            }))}
          >
            <span><i /></span>
          </button>
          <div className="sector-setting-name">
            <Icon name="sun" size={15} />
            <strong>盘前更新隔夜证据</strong>
          </div>
          <label className="sector-setting-control">
            <span>执行时间</span>
          <input
            type="time"
            aria-label="盘前证据更新执行时间"
            min="06:00"
            max="09:25"
            value={draft.overnightTime}
            disabled={!draft.overnightEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              overnightTime: event.target.value,
            }))}
          />
          </label>
        </div>
        <div
          className="sector-setting-row"
          data-enabled={draft.intradayEnabled}
        >
          <button
            type="button"
            role="switch"
            aria-checked={draft.intradayEnabled}
            aria-label="自动盘中刷新实时排名"
            className={'sector-setting-switch' + (
              draft.intradayEnabled ? ' on' : ''
            )}
            onClick={() => setDraft((current) => ({
              ...current,
              intradayEnabled: !current.intradayEnabled,
            }))}
          >
            <span><i /></span>
          </button>
          <div className="sector-setting-name">
            <Icon name="activity" size={15} />
            <strong>盘中刷新实时排名</strong>
          </div>
          <label className="sector-setting-control">
            <span>更新频率</span>
          <select
            aria-label="盘中实时排名更新频率"
            value={draft.intradayIntervalMinutes}
            disabled={!draft.intradayEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              intradayIntervalMinutes: Number(event.target.value),
            }))}
          >
            <option value={5}>5分钟</option>
            <option value={10}>10分钟</option>
            <option value={15}>15分钟</option>
          </select>
          </label>
        </div>
      </div>
      <div className="sector-setting-actions">
        {error && <span role="alert">{error}</span>}
        <button type="button" className="row-btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="row-btn primary" disabled={saving}>
          <Icon name={saving ? 'pulse' : 'check'} size={14} />
          {saving ? '保存中' : '保存自动设置'}
        </button>
      </div>
    </form>
  )
}
