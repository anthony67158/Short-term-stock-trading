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
      <div className="sector-setting-group">
        <label className="sector-setting-toggle">
          <input
            type="checkbox"
            checked={draft.autoEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              autoEnabled: event.target.checked,
            }))}
          />
          <span>收盘正式版</span>
        </label>
        <label>
          <span>生成时间</span>
          <input
            type="time"
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
      <div className="sector-setting-group">
        <label className="sector-setting-toggle">
          <input
            type="checkbox"
            checked={draft.overnightEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              overnightEnabled: event.target.checked,
            }))}
          />
          <span>盘前证据复核</span>
        </label>
        <label>
          <span>复核时间</span>
          <input
            type="time"
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
      <div className="sector-setting-group">
        <label className="sector-setting-toggle">
          <input
            type="checkbox"
            checked={draft.intradayEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              intradayEnabled: event.target.checked,
            }))}
          />
          <span>盘中自动刷新</span>
        </label>
        <label>
          <span>刷新间隔</span>
          <select
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
      <div className="sector-setting-actions">
        {error && <span role="alert">{error}</span>}
        <button type="button" className="row-btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="row-btn primary" disabled={saving}>
          <Icon name={saving ? 'pulse' : 'check'} size={14} />
          {saving ? '保存中' : '保存'}
        </button>
      </div>
    </form>
  )
}
