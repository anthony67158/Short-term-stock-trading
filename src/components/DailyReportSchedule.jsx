import { useEffect, useState } from 'react'
import Icon from './Icon'
import {
  fetchDailyReportSchedule,
  saveDailyReportSchedule,
} from '../ai'
import {
  DEFAULT_DAILY_REPORT_SCHEDULE,
} from '../../shared/dailyReportSchedule.js'

const SESSIONS = [
  { key: 'morning', label: '盘前日报' },
  { key: 'noon', label: '午间日报' },
  { key: 'evening', label: '收盘日报' },
]

const sessionLabel = (key) =>
  SESSIONS.find((item) => item.key === key)?.label || key

function runtimeText(runtime) {
  if (runtime?.active?.status === 'running') {
    return `正在自动生成：${sessionLabel(runtime.active.session)}`
  }
  if (runtime?.latest?.status === 'failed') {
    return `最近自动失败：${runtime.latest.error || sessionLabel(runtime.latest.session)}`
  }
  if (runtime?.latest?.status === 'done') {
    return `最近自动完成：${runtime.latest.runKey}`
  }
  return ''
}

export default function DailyReportSchedule() {
  const [state, setState] = useState({
    loading: true,
    saving: false,
    error: '',
    notice: '',
    settings: DEFAULT_DAILY_REPORT_SCHEDULE,
    runtime: null,
  })

  const load = async () => {
    try {
      const response = await fetchDailyReportSchedule()
      setState((current) => ({
        ...current,
        loading: false,
        error: '',
        settings: response.settings,
        runtime: response.state,
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error?.message || '自动计划读取失败',
      }))
    }
  }

  useEffect(() => {
    void load()
    const timer = setInterval(load, 30000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (patch) => {
    setState((current) => ({
      ...current,
      notice: '',
      settings: { ...current.settings, ...patch },
    }))
  }

  const updateSession = (key, patch) => {
    setState((current) => ({
      ...current,
      notice: '',
      settings: {
        ...current.settings,
        [key]: { ...current.settings[key], ...patch },
      },
    }))
  }

  const submit = async (event) => {
    event.preventDefault()
    setState((current) => ({
      ...current,
      saving: true,
      error: '',
      notice: '',
    }))
    try {
      const response = await saveDailyReportSchedule(state.settings)
      setState((current) => ({
        ...current,
        saving: false,
        settings: response.settings,
        runtime: response.state,
        notice: '自动计划已保存',
      }))
    } catch (error) {
      setState((current) => ({
        ...current,
        saving: false,
        error: error?.message || '自动计划保存失败',
      }))
    }
  }

  return (
    <form className="dr-auto-settings" onSubmit={submit}>
      <div className="dr-auto-head">
        <div>
          <strong>每日自动生成</strong>
          <span>北京时间 · 盘前每日，午间与收盘仅交易日</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={state.settings.enabled}
          aria-label="开启或关闭日报自动生成"
          className={'dr-auto-switch' + (state.settings.enabled ? ' on' : '')}
          disabled={state.loading || state.saving}
          onClick={() => update({ enabled: !state.settings.enabled })}
        >
          <span />
        </button>
      </div>
      <div className="dr-auto-grid">
        {SESSIONS.map((item) => {
          const value = state.settings[item.key]
          return (
            <div
              className="dr-auto-row"
              data-enabled={state.settings.enabled && value.enabled}
              key={item.key}
            >
              <button
                type="button"
                role="switch"
                aria-checked={value.enabled}
                aria-label={`开启或关闭${item.label}`}
                className={'dr-auto-switch compact' + (value.enabled ? ' on' : '')}
                disabled={!state.settings.enabled || state.loading || state.saving}
                onClick={() => updateSession(item.key, {
                  enabled: !value.enabled,
                })}
              >
                <span />
              </button>
              <label>
                <span>{item.label}</span>
                <input
                  type="time"
                  aria-label={`${item.label}生成时间`}
                  value={value.time}
                  disabled={!state.settings.enabled || !value.enabled || state.loading || state.saving}
                  onChange={(event) => updateSession(
                    item.key,
                    { time: event.target.value },
                  )}
                />
              </label>
            </div>
          )
        })}
      </div>
      <div className="dr-auto-actions">
        <span role={
          state.error || state.runtime?.latest?.status === 'failed'
            ? 'alert'
            : 'status'
        }>
          {state.error || state.notice || runtimeText(state.runtime)}
        </span>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={state.loading || state.saving}
        >
          <Icon
            name={state.saving ? 'refresh' : 'check'}
            size={13}
            className={state.saving ? 'spin' : ''}
          />
          {state.saving ? '保存中' : '保存计划'}
        </button>
      </div>
    </form>
  )
}
