import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from './Icon'
import { llmConfigStore } from '../llmConfigStore'
import { api } from '../apiBase'
import { accountRequestHeaders } from '../quantModel'

const ROLE_ORDER = [
  'advisor',
  'review',
  'portfolio',
  'agent',
  'daily',
  'sector',
  'judge',
]

const ROLE_META = {
  advisor: { icon: 'spark', label: '军师AI操作建议生成', badge: '2 路并行' },
  review: { icon: 'shield', label: '复核角色', badge: '2 路并行' },
  portfolio: { icon: 'layers', label: '持仓分布分析', badge: '组合' },
  agent: { icon: 'brain', label: '智能体助手', badge: '工具调用' },
  daily: { icon: 'history', label: '策略日报', badge: '日报' },
  sector: { icon: 'chart', label: '板块前瞻', badge: '板块' },
  judge: { icon: 'gauge', label: '交易确认 Judge', badge: '低延迟' },
}

const CONFIG_REQUEST_TIMEOUT_MS = {
  get: 30000,
  verify: 20000,
  test: 130000,
  save: 30000,
}

async function callConfig(action, payload = {}) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    CONFIG_REQUEST_TIMEOUT_MS[action] || 30000,
  )
  try {
    const response = await fetch(api('/api/llm_config'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...accountRequestHeaders(),
      },
      body: JSON.stringify({ action, ...payload }),
    })
    return response.json()
  } catch (reason) {
    if (reason?.name === 'AbortError') {
      throw new Error('配置请求超时，请稍后重试')
    }
    throw reason
  } finally {
    clearTimeout(timer)
  }
}

function emptyEndpoint(role, index, definition = {}) {
  return {
    id: `${role}-${index + 1}`,
    role,
    slot: index + 1,
    baseUrl: '',
    apiKey: '',
    apiKeyMask: '',
    hasKey: false,
    model: definition.def || '',
    reasoning: role === 'sector',
    enabled: true,
    source: '',
  }
}

function normalizeRoleEndpoints(config, roles, roleSlots) {
  return Object.fromEntries(ROLE_ORDER.map((role) => {
    const count = Math.max(1, Number(roleSlots?.[role]) || 1)
    const stored = Array.isArray(config?.roleEndpoints?.[role])
      ? config.roleEndpoints[role]
      : []
    return [
      role,
      Array.from({ length: count }, (_, index) => ({
        ...emptyEndpoint(role, index, roles?.[role]),
        ...(stored[index] || {}),
        apiKey: '',
      })),
    ]
  }))
}

function endpointKey(role, index) {
  return `${role}-${index + 1}`
}

function healthClass(health) {
  if (!health) return ''
  if (health.cooling) return ' cooling'
  if (health.fails) return ' warn'
  return ' ok'
}

function healthLabel(health) {
  if (!health) return '待验证'
  if (health.cooling) {
    return `熔断 ${Math.ceil((health.cooldownMsLeft || 0) / 1000)}s`
  }
  return `在途 ${health.inflight || 0} · 失败 ${health.fails || 0}`
}

export default function LLMConfig() {
  const [busy, setBusy] = useState(false)
  const [roles, setRoles] = useState({})
  const [roleSlots, setRoleSlots] = useState({})
  const [roleEndpoints, setRoleEndpoints] = useState({})
  const [pool, setPool] = useState([])
  const [testing, setTesting] = useState({})
  const [modelLists, setModelLists] = useState({})
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadCurrent = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const result = await callConfig('get')
      if (!result?.ok) throw new Error(result?.error || '读取配置失败')
      const nextRoles = result.roles || {}
      const nextSlots = result.roleSlots || {}
      setRoles(nextRoles)
      setRoleSlots(nextSlots)
      setRoleEndpoints(normalizeRoleEndpoints(
        result.config || {},
        nextRoles,
        nextSlots,
      ))
      setPool(Array.isArray(result.pool) ? result.pool : [])
    } catch (reason) {
      setError(reason?.message || '读取配置失败')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    loadCurrent()
  }, [loadCurrent])

  const poolById = useMemo(
    () => Object.fromEntries((pool || []).map((item) => [item.id, item])),
    [pool],
  )

  const updateEndpoint = (role, index, patch) => {
    setRoleEndpoints((current) => ({
      ...current,
      [role]: (current[role] || []).map((endpoint, itemIndex) =>
        itemIndex === index ? { ...endpoint, ...patch } : endpoint
      ),
    }))
  }

  const validateEndpoint = (role, index) => {
    const endpoint = roleEndpoints?.[role]?.[index]
    if (!endpoint || endpoint.enabled === false) return ''
    if (!String(endpoint.baseUrl || '').trim()) return '缺少 Base URL'
    if (!String(endpoint.model || '').trim()) return '缺少模型'
    if (!String(endpoint.apiKey || '').trim() && !endpoint.hasKey) {
      return '缺少 API Key'
    }
    return ''
  }

  const verifyEndpoint = async (role, index) => {
    const key = endpointKey(role, index)
    const endpoint = roleEndpoints?.[role]?.[index]
    const invalid = validateEndpoint(role, index)
    if (invalid) {
      setTesting((current) => ({
        ...current,
        [key]: { ok: false, message: invalid },
      }))
      return false
    }
    if (endpoint.enabled === false) return true
    setTesting((current) => ({
      ...current,
      [key]: { busy: true, message: '' },
    }))
    try {
      const result = await callConfig('verify', {
        role,
        slot: index + 1,
        baseUrl: endpoint.baseUrl.trim(),
        apiKey: endpoint.apiKey.trim(),
      })
      const available = Array.isArray(result?.models)
        ? result.models
        : []
      setModelLists((current) => ({ ...current, [key]: available }))
      setTesting((current) => ({
        ...current,
        [key]: {
          ok: !!result?.ok,
          message: result?.ok
            ? (result.listable
                ? `可用 · ${available.length} 个模型`
                : '端点可用')
            : (result?.error || '验证失败'),
        },
      }))
      return !!result?.ok
    } catch (reason) {
      setTesting((current) => ({
        ...current,
        [key]: {
          ok: false,
          message: reason?.message || '验证失败',
        },
      }))
      return false
    }
  }

  const activeTargets = () => ROLE_ORDER.flatMap((role) =>
    (roleEndpoints[role] || [])
      .map((endpoint, index) => ({ role, index, endpoint }))
      .filter(({ endpoint }) => endpoint.enabled !== false)
  )

  const testAll = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const targets = activeTargets()
      const invalid = targets
        .map(({ role, index }) => ({
          role,
          index,
          error: validateEndpoint(role, index),
        }))
        .filter((item) => item.error)
      if (invalid.length) {
        throw new Error(`${roles[invalid[0].role]?.label || invalid[0].role} · 端点 ${invalid[0].index + 1}：${invalid[0].error}`)
      }
      const results = await Promise.all(targets.map(async ({
        role,
        index,
        endpoint,
      }) => {
        const key = endpointKey(role, index)
        setTesting((current) => ({
          ...current,
          [key]: { busy: true, message: '' },
        }))
        const result = await callConfig('test', {
          role,
          slot: index + 1,
          baseUrl: endpoint.baseUrl.trim(),
          apiKey: endpoint.apiKey.trim(),
          models: [endpoint.model.trim()],
        })
        const item = result?.results?.[0]
        setTesting((current) => ({
          ...current,
          [key]: {
            ok: !!item?.ok,
            message: item?.ok
              ? `可用 · ${item.ms}ms`
              : (item?.error || result?.error || '测试失败'),
          },
        }))
        return !!item?.ok
      }))
      if (!results.every(Boolean)) throw new Error('部分端点测试失败')
      setNotice(`全部 ${targets.length} 个端点可用`)
    } catch (reason) {
      setError(reason?.message || '端点测试失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const targets = activeTargets()
      const invalid = targets
        .map(({ role, index }) => ({
          role,
          index,
          error: validateEndpoint(role, index),
        }))
        .find((item) => item.error)
      if (invalid) {
        throw new Error(`${roles[invalid.role]?.label || invalid.role} · 端点 ${invalid.index + 1}：${invalid.error}`)
      }
      const payload = Object.fromEntries(ROLE_ORDER.map((role) => [
        role,
        (roleEndpoints[role] || []).map((endpoint, index) => ({
          id: endpointKey(role, index),
          baseUrl: String(endpoint.baseUrl || '').trim(),
          apiKey: String(endpoint.apiKey || '').trim(),
          model: String(endpoint.model || '').trim(),
          reasoning: !!endpoint.reasoning,
          enabled: endpoint.enabled !== false,
        })),
      ]))
      const result = await callConfig('save', {
        roleEndpoints: payload,
      })
      if (!result?.ok) throw new Error(result?.error || '保存失败')
      setPool(Array.isArray(result.pool) ? result.pool : [])
      setRoleEndpoints(normalizeRoleEndpoints(
        result.config || {},
        roles,
        roleSlots,
      ))
      setNotice('已保存，所有角色即时切换到独立端点')
    } catch (reason) {
      setError(reason?.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const renderEndpoint = (role, endpoint, index) => {
    const key = endpointKey(role, index)
    const status = testing[key] || {}
    const health = poolById[endpoint.id] || poolById[key]
    const modelList = modelLists[key] || []
    return (
      <div
        className={'llm-role-endpoint' + (
          endpoint.enabled === false ? ' off' : ''
        )}
        key={key}
      >
        <div className="llm-role-endpoint-head">
          <strong>
            {Number(roleSlots?.[role]) > 1
              ? `端点 ${index + 1}`
              : '独立端点'}
          </strong>
          <span className={'llm-ep-health' + healthClass(health)}>
            {healthLabel(health)}
          </span>
          <button
            type="button"
            className={'llm-reason-toggle' + (
              endpoint.enabled !== false ? ' on' : ''
            )}
            aria-label={`${roles[role]?.label || role}端点${endpoint.enabled !== false ? '已启用' : '已停用'}`}
            onClick={() => updateEndpoint(role, index, {
              enabled: endpoint.enabled === false,
            })}
          >
            <span className="llm-reason-text">
              {endpoint.enabled !== false ? '启用' : '停用'}
            </span>
            <span className="llm-reason-track">
              <span className="llm-reason-thumb" />
            </span>
          </button>
        </div>
        <div className="llm-role-endpoint-grid">
          <label>
            <span>Base URL</span>
            <input
              className="wl-input auth-input"
              placeholder="https://gateway.example/v1"
              value={endpoint.baseUrl || ''}
              spellCheck={false}
              onChange={(event) => updateEndpoint(role, index, {
                baseUrl: event.target.value,
              })}
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              className="wl-input auth-input"
              type="password"
              placeholder={endpoint.hasKey
                ? `已保存（${endpoint.apiKeyMask || '****'}），留空沿用`
                : '填写专用 API Key'}
              value={endpoint.apiKey || ''}
              spellCheck={false}
              onChange={(event) => updateEndpoint(role, index, {
                apiKey: event.target.value,
              })}
            />
          </label>
        </div>
        <div className="llm-role-endpoint-model">
          <label>
            <span>模型</span>
            <input
              className="wl-input auth-input"
              list={`llm-models-${key}`}
              placeholder={roles[role]?.def || '模型名称'}
              value={endpoint.model || ''}
              spellCheck={false}
              onChange={(event) => updateEndpoint(role, index, {
                model: event.target.value,
              })}
            />
            <datalist id={`llm-models-${key}`}>
              {modelList.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          {role !== 'advisor' && (
            <button
              type="button"
              className={'llm-reason-toggle' + (
                endpoint.reasoning ? ' on' : ''
              )}
              aria-label={`${roles[role]?.label || role}深度思考${endpoint.reasoning ? '已开启' : '已关闭'}`}
              onClick={() => updateEndpoint(role, index, {
                reasoning: !endpoint.reasoning,
              })}
            >
              <span className="llm-reason-text">
                <Icon name="brain" size={12} />
                深度思考
              </span>
              <span className="llm-reason-track">
                <span className="llm-reason-thumb" />
              </span>
            </button>
          )}
          <button
            type="button"
            className="btn llm-ep-verify"
            disabled={busy || status.busy || endpoint.enabled === false}
            onClick={() => verifyEndpoint(role, index)}
          >
            <Icon
              name={status.busy ? 'refresh' : 'bolt'}
              size={13}
              className={status.busy ? 'spin' : ''}
            />
            验证
          </button>
        </div>
        {status.message && (
          <div className={'llm-ep-msg' + (status.ok ? ' ok' : ' bad')}>
            {status.message}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="modal-mask"
      onClick={(event) => {
        if (event.target === event.currentTarget) llmConfigStore.close()
      }}
    >
      <div
        className="llm-cfg"
        role="dialog"
        aria-modal="true"
        aria-label="AI 模型配置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-bar">
          <div className="modal-title">
            <Icon name="brain" size={18} />
            AI 角色端点
            <span className="llm-role-count">7 个角色 · 9 个端点</span>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="关闭 AI 模型配置"
            onClick={() => llmConfigStore.close()}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="llm-body llm-role-list">
          {busy && !Object.keys(roleEndpoints).length ? (
            <div className="llm-testing">
              <Icon name="refresh" size={14} className="spin" />
              正在读取角色端点
            </div>
          ) : ROLE_ORDER.map((role) => {
            const meta = ROLE_META[role] || ROLE_META.agent
            const endpoints = roleEndpoints[role] || []
            return (
              <section className="llm-role-group" key={role}>
                <header>
                  <span className="llm-role-icon">
                    <Icon name={meta.icon} size={14} />
                  </span>
                  <strong>{roles[role]?.label || meta.label}</strong>
                  <small>{meta.badge}</small>
                </header>
                <div className={'llm-role-endpoints' + (
                  endpoints.length > 1 ? ' dual' : ''
                )}>
                  {endpoints.map((endpoint, index) =>
                    renderEndpoint(role, endpoint, index)
                  )}
                </div>
              </section>
            )
          })}
          {error && <div className="err llm-msg">{error}</div>}
          {notice && <div className="llm-msg ok">{notice}</div>}
        </div>

        <div className="llm-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={testAll}
          >
            <Icon name={busy ? 'refresh' : 'gauge'} size={14}
              className={busy ? 'spin' : ''} />
            验证全部
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={save}
          >
            <Icon name="check" size={14} />
            保存配置
          </button>
        </div>
      </div>
    </div>
  )
}
