import { useState, useEffect, useCallback } from 'react'
import Icon from './Icon'
import { llmConfigStore } from '../llmConfigStore'
import { api } from '../apiBase'

// ============ AI 模型配置向导（低频操作，入口藏在账号菜单）============
// 三步走，但同屏切换：
//   1) 连接：Base URL + API Key → 「验证并继续」调 verify 拉取可用模型
//   2) 分工：为系统里 4 个 AI 角色各选一个模型（下拉来自 verify 的模型清单，可手填）
//   3) 测试:逐个模型 ping 可用性 + 时延 → 「完成并保存」写入 OSS，全系统即时生效
// 设计要点:Key 只在提交时上送后端,后端只回 mask;重开向导时 get 读取当前配置(Key 显示掩码)。

const STEPS = [
  { n: 1, label: '连接', icon: 'bolt' },
  { n: 2, label: '分工', icon: 'brain' },
  { n: 3, label: '测试', icon: 'gauge' },
]

async function callConfig(action, payload) {
  const res = await fetch(api('/api/llm_config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  return res.json()
}

export default function LLMConfig() {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')

  // 连接信息
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)      // 后端是否已存有 Key（留空则沿用）
  const [keyMask, setKeyMask] = useState('')

  // 多端点资源池（可选：配置后覆盖单端点，提供轮询/最少在途路由 + 熔断故障转移）
  const [endpoints, setEndpoints] = useState([])   // [{id, baseUrl, apiKeyMask, hasKey, weight, enabled, apiKey?(仅本地新输入)}]
  const [pool, setPool] = useState([])             // [{id, baseUrl, inflight, fails, cooling, cooldownMsLeft}]
  const [showPool, setShowPool] = useState(false)  // 展开多端点面板
  const [epTesting, setEpTesting] = useState({})   // { [id]: {ok, msg} } 单端点验证结果
  const [judgeRole, setJudgeRole] = useState({})
  const [judgeEndpoint, setJudgeEndpoint] = useState({
    baseUrl: '', apiKey: '', apiKeyMask: '', hasKey: false,
    model: '', reasoning: false, enabled: true,
  })
  const [judgePool, setJudgePool] = useState(null)
  const [judgeTesting, setJudgeTesting] = useState({})
  const [judgeModelList, setJudgeModelList] = useState([])

  // 角色 & 模型
  const [roles, setRoles] = useState({})           // { chat:{label,def}, ... }
  const [models, setModels] = useState({})         // { chat:'x', advisor:'y', ... }
  const [reasoning, setReasoning] = useState({})   // { chat:true/false, ... } 深度思考开关
  const [modelList, setModelList] = useState([])   // 可选模型清单（来自 verify，池模式下为各端点并集）
  const [listable, setListable] = useState(false)  // 端点是否支持 /models 列举
  const [epModels, setEpModels] = useState({})     // { [id]: {ok, listable, models:[], reason} } 各端点可用模型(池模式)

  // 测试结果
  const [testResults, setTestResults] = useState(null) // [{model, ok, ms, error?}]

  // 打开时读取当前配置
  const loadCurrent = useCallback(async () => {
    setBusy(true); setErr('')
    try {
      const j = await callConfig('get', {})
      if (j && j.ok) {
        const c = j.config || {}
        setBaseUrl(c.baseUrl || '')
        setHasKey(!!c.hasKey)
        setKeyMask(c.apiKeyMask || '')
        setRoles(j.roles || {})
        setJudgeRole(j.judgeRole || {})
        setModels({ ...(c.models || {}) })
        setReasoning({ ...(c.reasoning || {}) })
        setJudgeEndpoint({
          baseUrl: c.judgeEndpoint?.baseUrl || '',
          apiKey: '',
          apiKeyMask: c.judgeEndpoint?.apiKeyMask || '',
          hasKey: !!c.judgeEndpoint?.hasKey,
          model: c.judgeEndpoint?.model || j.judgeRole?.def || '',
          reasoning: !!c.judgeEndpoint?.reasoning,
          enabled: c.judgeEndpoint?.enabled !== false,
          source: c.judgeEndpoint?.source || '',
        })
        setJudgePool(j.judgePool || null)
        const eps = Array.isArray(c.endpoints) ? c.endpoints : []
        setEndpoints(eps)
        setPool(Array.isArray(j.pool) ? j.pool : [])
        setShowPool(eps.length > 0)
      } else {
        setErr((j && j.error) || '读取配置失败')
      }
    } catch (e) {
      setErr('读取配置失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { loadCurrent() }, [loadCurrent])

  const close = () => llmConfigStore.close()

  // 池模式下有效端点(启用+有 baseUrl)
  const activeEndpoints = () => endpoints.filter((e) => e.enabled !== false && (e.baseUrl || '').trim())
  const poolMode = showPool && activeEndpoints().length > 0
  // 已配置但被停用的端点(有 baseUrl 却 enabled===false)——用于提示"为何没列出来"
  const disabledEndpoints = () => endpoints.filter((e) => e.enabled === false && (e.baseUrl || '').trim())

  // host 简写(用于端点标签)
  const hostLabel = (url, i) => (url ? String(url).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : `端点${i + 1}`)

  // Step 2 要罗列的端点卡片:主端点(默认,模型=全局 models) + 各资源池端点(模型=端点自带 models)。
  // 主端点始终作为第一张卡(只要填了 Base URL);poolMode 下再追加各附加端点。
  const cardEndpoints = () => {
    const list = []
    if (baseUrl.trim()) list.push({ id: 'default', label: '主端点', host: hostLabel(baseUrl, 0), isMain: true })
    if (poolMode) {
      activeEndpoints().forEach((ep, i) => {
        list.push({ id: ep.id, label: `端点 #${i + 1}`, host: hostLabel(ep.baseUrl, i), isMain: false, ep })
      })
    }
    return list
  }

  // 取/设某端点某角色的模型:主端点走全局 models;附加端点走该端点自带 models
  const cardModel = (card, role) => (card.isMain ? (models[role] || '') : ((card.ep.models && card.ep.models[role]) || ''))
  const setCardModel = (card, role, v) => {
    if (card.isMain) { setModel(role, v); return }
    setEp(card.ep.id, { models: { ...(card.ep.models || {}), [role]: v } })
  }
  // 附加端点某角色留空 = 该端点不承接此角色(见 _llm_pool.endpointServesRole);不再借用主端点模型。

  // 取/设某端点某角色的「深度思考」开关:主端点走全局 reasoning;附加端点走该端点自带 reasoning
  //   (不同网关同名角色可能是不同模型,是否支持/需要推理各不相同 → 每端点独立)
  const cardReason = (card, role) => (card.isMain ? !!reasoning[role] : !!(card.ep.reasoning && card.ep.reasoning[role]))
  const setCardReason = (card, role, v) => {
    if (card.isMain) { setReason(role, v); return }
    setEp(card.ep.id, { reasoning: { ...(card.ep.reasoning || {}), [role]: !!v } })
  }

  const setJudge = (patch) => setJudgeEndpoint((current) => ({ ...current, ...patch }))
  const verifyJudgeEndpoint = async ({ required = false } = {}) => {
    if (judgeEndpoint.enabled === false) return true
    if (!judgeEndpoint.baseUrl.trim()) {
      if (required) setErr('请填写 Judge 专用端点地址')
      return false
    }
    if (!judgeEndpoint.model.trim()) {
      if (required) setErr('请填写 Judge 专用模型')
      return false
    }
    if (!judgeEndpoint.apiKey.trim() && !judgeEndpoint.hasKey) {
      if (required) setErr('请填写 Judge 专用端点密钥')
      return false
    }
    setJudgeTesting({ busy: true })
    try {
      const response = await callConfig('verify', {
        target: 'judge',
        baseUrl: judgeEndpoint.baseUrl.trim(),
        apiKey: judgeEndpoint.apiKey.trim(),
      })
      const ok = !!(response && response.ok)
      const available = Array.isArray(response?.models) ? response.models : []
      setJudgeModelList(available)
      setJudgeTesting({
        ok,
        msg: ok
          ? (response.listable ? `可用 · ${available.length} 个模型` : '端点可用')
          : (response?.error || '验证失败'),
      })
      if (!ok && required) setErr(`Judge 专用端点验证失败：${response?.error || '请检查连接信息'}`)
      return ok
    } catch (error) {
      setJudgeTesting({ ok: false, msg: error.message || String(error) })
      if (required) setErr('Judge 专用端点验证失败')
      return false
    }
  }

  // —— Step 1 → 2：验证连接、拉取模型清单 ——
  const verifyAndNext = async () => {
    setErr(''); setNotice('')
    if (!(await verifyJudgeEndpoint({ required: true }))) return
    // ===== 池模式:逐端点验证(含主端点),各端点分别记录可用模型清单 =====
    if (poolMode) {
      const eps = activeEndpoints()
      setBusy(true)
      try {
        // 待验证清单:主端点(id 'default',用 step-1 的 baseUrl/apiKey) + 各附加端点
        const toVerify = []
        if (baseUrl.trim()) {
          const mk = apiKey.trim() && !/\*/.test(apiKey) ? apiKey.trim() : ''
          toVerify.push({ id: 'default', baseUrl: baseUrl.trim(), key: mk, hasKey })
        }
        eps.forEach((ep) => {
          const k = (ep.apiKey && !/\*/.test(ep.apiKey)) ? ep.apiKey.trim() : ''
          toVerify.push({ id: ep.id, baseUrl: ep.baseUrl.trim(), key: k, hasKey: ep.hasKey })
        })
        const results = await Promise.all(toVerify.map(async (t) => {
          if (!t.key) return { id: t.id, ok: null, listable: false, models: [], reason: t.hasKey ? '已存 Key,无法在线列举' : '缺少 Key' }
          const j = await callConfig('verify', { baseUrl: t.baseUrl, apiKey: t.key })
          return { id: t.id, ok: !!(j && j.ok), listable: !!(j && j.listable), models: Array.isArray(j && j.models) ? j.models : [], reason: (j && j.ok) ? '' : ((j && j.error) || '验证失败') }
        }))
        const map = {}; results.forEach((r) => { map[r.id] = r })
        setEpModels(map)
        // 并集:供各端点 datalist 兜底提示
        const union = [...new Set(results.flatMap((r) => r.models))]
        setModelList(union)
        const anyListable = results.some((r) => r.listable)
        setListable(anyListable)
        // 主端点各角色若空,用角色默认兜底
        setModels((prev) => {
          const next = { ...prev }
          Object.keys(roles).forEach((k) => { if (!next[k]) next[k] = roles[k].def })
          return next
        })
        const failed = results.filter((r) => r.ok === false)
        if (failed.length) setNotice(`${failed.length} 个端点验证失败,请回上一步检查;仍可继续为可用端点分配模型`)
        else if (!anyListable) setNotice('端点未提供模型列表,请手动填写模型名(下一步可测可用性)')
        setStep(2)
      } catch (e) {
        setErr('验证失败:' + (e.message || e))
      } finally { setBusy(false) }
      return
    }
    // ===== 单端点模式(原逻辑) =====
    if (!baseUrl.trim()) { setErr('请填写 Base URL'); return }
    if (!apiKey.trim() && !hasKey) { setErr('请填写 API Key'); return }
    setBusy(true)
    try {
      const j = await callConfig('verify', { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      if (!j || !j.ok) { setErr((j && j.error) || 'API Key 或 Base URL 无效'); setBusy(false); return }
      const list = Array.isArray(j.models) ? j.models : []
      setModelList(list)
      setListable(!!j.listable)
      setEpModels({})
      // 若某角色尚未选模型，用默认值兜底
      setModels((prev) => {
        const next = { ...prev }
        Object.keys(roles).forEach((k) => { if (!next[k]) next[k] = roles[k].def })
        return next
      })
      if (!j.listable) setNotice('该端点未提供模型列表，请手动填写模型名（可在下一步测试其可用性）')
      setStep(2)
    } catch (e) {
      setErr('验证失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // —— Step 2 → 3：测试所选模型可用性 ——
  const testAndNext = async () => {
    setErr(''); setNotice(''); setTestResults(null)
    // 通用角色和 Judge 必须分别用各自端点测试，避免“模型可用”结论测错网关。
    const gathered = new Set(Object.keys(roles).map((role) => models[role]).filter(Boolean))
    if (poolMode) {
      activeEndpoints().forEach((ep) => {
        Object.entries(ep.models || {}).forEach(([role, model]) => {
          if (role !== 'judge' && model) gathered.add(model)
        })
      })
    }
    const chosen = [...gathered]
    if (!chosen.length && judgeEndpoint.enabled === false) {
      setErr('请至少为一个角色选择模型')
      return
    }

    let testBase = baseUrl.trim(), testKey = apiKey.trim()
    if (poolMode) {
      if (!testBase || (!testKey && !hasKey)) {
        const ep = activeEndpoints().find((e) => e.apiKey && !/\*/.test(e.apiKey))
        if (ep) { testBase = ep.baseUrl.trim(); testKey = ep.apiKey.trim() }
      }
    }

    setStep(3)
    setBusy(true)
    try {
      const requests = []
      if (chosen.length && testBase && (testKey || hasKey)) {
        requests.push(
          callConfig('test', { baseUrl: testBase, apiKey: testKey, models: chosen })
            .then((result) => ({ target: '通用端点', result }))
        )
      }
      if (judgeEndpoint.enabled !== false) {
        requests.push(
          callConfig('test', {
            target: 'judge',
            baseUrl: judgeEndpoint.baseUrl.trim(),
            apiKey: judgeEndpoint.apiKey.trim(),
            models: [judgeEndpoint.model.trim()],
          }).then((result) => ({ target: 'Judge 专用端点', result }))
        )
      }
      if (!requests.length) {
        setNotice('当前没有可在线测试的端点，可直接保存配置')
        setTestResults([])
        return
      }
      const responses = await Promise.all(requests)
      const results = responses.flatMap(({ target, result }) =>
        (Array.isArray(result?.results) ? result.results : []).map((item) => ({ ...item, target }))
      )
      setTestResults(results)
      if (responses.some(({ result }) => !result?.ok)) {
        setNotice('部分模型不可用，可返回上一步检查端点或更换模型')
      }
    } catch (e) {
      setErr('测试失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // —— Step 3：保存 ——
  const save = async () => {
    setErr(''); setNotice('')
    setBusy(true)
    try {
      const payload = {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models: Object.fromEntries(Object.keys(roles).map((role) => [role, models[role] || ''])),
        reasoning: Object.fromEntries(Object.keys(roles).map((role) => [role, !!reasoning[role]])),
        judgeEndpoint: {
          baseUrl: judgeEndpoint.baseUrl.trim(),
          apiKey: judgeEndpoint.apiKey.trim(),
          model: judgeEndpoint.model.trim(),
          reasoning: !!judgeEndpoint.reasoning,
          enabled: judgeEndpoint.enabled !== false,
        },
      }
      // 仅当用户启用了多端点面板时才提交 endpoints(整组替换);未启用则传空数组=清空池,退回单端点
      if (showPool) {
        payload.endpoints = endpoints.map((e) => ({
          id: e.id,
          baseUrl: (e.baseUrl || '').trim(),
          // 新输入的明文 key 才上送;掩码/留空则不传(后端按 id 保留原 key)
          apiKey: (e.apiKey != null && e.apiKey !== '') ? e.apiKey.trim() : '',
          weight: e.weight,
          enabled: e.enabled !== false,
          // 通用端点只承接通用角色，Judge 使用上面的独立端点。
          models: e.models && typeof e.models === 'object'
            ? Object.fromEntries(Object.entries(e.models).filter(([role, value]) =>
              role !== 'judge' && value && String(value).trim()
            ))
            : {},
          reasoning: e.reasoning && typeof e.reasoning === 'object'
            ? Object.fromEntries(Object.entries(e.reasoning).filter(([role, value]) =>
              role !== 'judge' && value != null
            ).map(([role, value]) => [role, !!value]))
            : {},
        }))
      } else {
        payload.endpoints = []
      }
      const j = await callConfig('save', payload)
      if (!j || !j.ok) { setErr((j && j.error) || '保存失败'); setBusy(false); return }
      if (Array.isArray(j.pool)) setPool(j.pool)
      setJudgePool(j.judgePool || null)
      setNotice('已保存，全系统即时生效')
      setTimeout(() => close(), 800)
    } catch (e) {
      setErr('保存失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const setModel = (role, v) => setModels((prev) => ({ ...prev, [role]: v }))
  const setReason = (role, v) => setReasoning((prev) => ({ ...prev, [role]: !!v }))
  const okCount = testResults ? testResults.filter((r) => r.ok).length : 0

  // —— 多端点资源池：增删改 ——
  const addEndpoint = () => {
    const id = 'ep' + Date.now().toString(36)
    setEndpoints((prev) => [...prev, { id, baseUrl: '', apiKey: '', weight: 1, enabled: true, hasKey: false }])
    setShowPool(true)
  }
  const removeEndpoint = (id) => {
    setEndpoints((prev) => prev.filter((e) => e.id !== id))
    setEpTesting((prev) => { const n = { ...prev }; delete n[id]; return n })
  }
  const setEp = (id, patch) => setEndpoints((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))

  // 单端点连通性验证(复用后端 verify)。掩码/空 key 时用已存 key(后端按 id 沿用不了 verify,故此处需明文;掩码则提示)
  const verifyEndpoint = async (ep) => {
    setEpTesting((prev) => ({ ...prev, [ep.id]: { busy: true } }))
    try {
      const key = (ep.apiKey && !/\*/.test(ep.apiKey)) ? ep.apiKey.trim() : ''
      if (!ep.baseUrl.trim()) { setEpTesting((p) => ({ ...p, [ep.id]: { ok: false, msg: '缺少 Base URL' } })); return }
      if (!key && !ep.hasKey) { setEpTesting((p) => ({ ...p, [ep.id]: { ok: false, msg: '请填写 API Key' } })); return }
      if (!key && ep.hasKey) { setEpTesting((p) => ({ ...p, [ep.id]: { ok: false, msg: '已存 Key 无法在线验证，请重输后测' } })); return }
      const j = await callConfig('verify', { baseUrl: ep.baseUrl.trim(), apiKey: key })
      setEpTesting((p) => ({ ...p, [ep.id]: { ok: !!(j && j.ok), msg: (j && j.ok) ? (j.listable ? `可用·${(j.models || []).length} 模型` : '可用') : ((j && j.error) || '验证失败') } }))
    } catch (e) {
      setEpTesting((p) => ({ ...p, [ep.id]: { ok: false, msg: e.message || String(e) } }))
    }
  }
  const poolById = Object.fromEntries((pool || []).map((p) => [p.id, p]))

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="llm-cfg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-bar">
          <div className="modal-title"><Icon name="brain" size={18} /> AI 模型配置</div>
          <div className="modal-close" onClick={close}>×</div>
        </div>

        {/* 步骤指示器 */}
        <div className="llm-steps">
          {STEPS.map((s, i) => (
            <div key={s.n} className="llm-step-wrap">
              <div className={'llm-step' + (step === s.n ? ' active' : '') + (step > s.n ? ' done' : '')}>
                <span className="llm-step-dot">
                  {step > s.n ? <Icon name="check" size={12} /> : <Icon name={s.icon} size={13} />}
                </span>
                <span className="llm-step-label">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && <span className={'llm-step-line' + (step > s.n ? ' done' : '')} />}
            </div>
          ))}
        </div>

        <div className="llm-body">
          {/* Step 1：连接 */}
          {step === 1 && (
            <div className="llm-pane">
              <div className="llm-field">
                <label>Base URL</label>
                <input className="wl-input auth-input" placeholder="https://your-gateway/v1"
                  value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
                <div className="llm-hint">OpenAI 兼容网关地址，通常以 /v1 结尾</div>
              </div>
              <div className="llm-field">
                <label>API Key</label>
                <input className="wl-input auth-input" type="password" spellCheck={false}
                  placeholder={hasKey ? `已保存（${keyMask}），留空则沿用` : 'sk-...'}
                  value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <div className="llm-hint">仅用于后端调用，保存在服务端，前端不回显明文</div>
              </div>

              {/* 各角色模型速配（主端点）：无需先验证即可直接为每个 AI 角色指定模型 + 深度思考。
                  与第 2 步「分工」共享同一份 models/reasoning，改这里等于改主端点各角色配置。 */}
              {Object.keys(roles).length > 0 && (
                <div className="llm-field">
                  <label>各角色模型</label>
                  <div className="llm-hint" style={{ marginBottom: 8 }}>
                    为系统各处 AI 分别指定模型（对应主端点）。留空则用默认模型。多端点资源池可在下方展开单独配置。
                  </div>
                  <div className="llm-role-quick">
                    {Object.keys(roles).map((k) => (
                      <div className="llm-eprole" key={k}>
                        <div className="llm-eprole-head">
                          <label>{roles[k].label || k}</label>
                          <button type="button"
                            className={'llm-reason-toggle' + (reasoning[k] ? ' on' : '')}
                            onClick={() => setReason(k, !reasoning[k])}
                            title="开启后该角色调用支持推理的模型时启用深度思考(reasoning),响应更慎密但更慢">
                            <span className="llm-reason-text"><Icon name="brain" size={12} /> 深度思考 <em className="llm-reason-state">{reasoning[k] ? '已开' : '关'}</em></span>
                            <span className="llm-reason-track"><span className="llm-reason-thumb" /></span>
                          </button>
                        </div>
                        <input className="wl-input auth-input" list="llm-model-list-step1" spellCheck={false}
                          placeholder={roles[k].def}
                          value={models[k] || ''}
                          onChange={(e) => setModel(k, e.target.value)} />
                      </div>
                    ))}
                    <datalist id="llm-model-list-step1">
                      {modelList.map((m) => <option key={m} value={m} />)}
                    </datalist>
                  </div>
                </div>
              )}

              <div className={'llm-judge-card' + (judgeEndpoint.enabled === false ? ' off' : '')}>
                <div className="llm-judge-head">
                  <span className="llm-judge-title"><Icon name="gauge" size={14} /> Judge 专用端点</span>
                  <span className="llm-judge-badge">不参与通用资源池</span>
                  {judgePool && (
                    <span className={'llm-ep-health' + (judgePool.cooling ? ' cooling' : (judgePool.fails ? ' warn' : ' ok'))}>
                      {judgePool.cooling
                        ? `熔断中 ${Math.ceil((judgePool.cooldownMsLeft || 0) / 1000)}秒`
                        : `在途${judgePool.inflight || 0} · 失败${judgePool.fails || 0}`}
                    </span>
                  )}
                  <button type="button"
                    className={'llm-reason-toggle' + (judgeEndpoint.enabled !== false ? ' on' : '')}
                    onClick={() => setJudge({ enabled: judgeEndpoint.enabled === false })}
                    title="启用或停用 Judge 专用端点">
                    <span className="llm-reason-text">{judgeEndpoint.enabled !== false ? '启用' : '停用'}</span>
                    <span className="llm-reason-track"><span className="llm-reason-thumb" /></span>
                  </button>
                </div>
                <div className="llm-hint">
                  交易时机确认只走此端点，不与操盘军师和智能体争抢连接。建议使用低延迟、结构化输出稳定的模型。
                </div>
                {judgeEndpoint.source?.startsWith('legacy-') && (
                  <div className="llm-hint llm-hint-warn">
                    <Icon name="info" size={12} /> 已从旧配置迁移，目前仍沿用原连接；请改成独立网关或独立密钥后保存。
                  </div>
                )}
                <div className="llm-judge-grid">
                  <input className="wl-input auth-input" placeholder="Judge 专用 Base URL"
                    value={judgeEndpoint.baseUrl} spellCheck={false}
                    onChange={(event) => setJudge({ baseUrl: event.target.value })} />
                  <input className="wl-input auth-input" type="password" spellCheck={false}
                    placeholder={judgeEndpoint.hasKey
                      ? `已保存（${judgeEndpoint.apiKeyMask || '****'}），留空沿用`
                      : 'Judge 专用 API Key'}
                    value={judgeEndpoint.apiKey}
                    onChange={(event) => setJudge({ apiKey: event.target.value })} />
                </div>
                <div className="llm-judge-model-row">
                  <input className="wl-input auth-input" list="llm-judge-model-list" spellCheck={false}
                    placeholder={judgeRole.def || '低延迟模型名'}
                    value={judgeEndpoint.model}
                    onChange={(event) => setJudge({ model: event.target.value })} />
                  <datalist id="llm-judge-model-list">
                    {judgeModelList.map((model) => <option key={model} value={model} />)}
                  </datalist>
                  <button type="button"
                    className={'llm-reason-toggle' + (judgeEndpoint.reasoning ? ' on' : '')}
                    onClick={() => setJudge({ reasoning: !judgeEndpoint.reasoning })}
                    title="Judge 通常建议关闭深度思考以降低确认延迟">
                    <span className="llm-reason-text"><Icon name="brain" size={12} /> 深度思考</span>
                    <span className="llm-reason-track"><span className="llm-reason-thumb" /></span>
                  </button>
                  <button type="button" className="btn llm-ep-verify"
                    disabled={judgeTesting.busy || judgeEndpoint.enabled === false}
                    onClick={() => verifyJudgeEndpoint()}>
                    <Icon name={judgeTesting.busy ? 'refresh' : 'bolt'} size={13} className={judgeTesting.busy ? 'spin' : ''} />
                    验证专用端点
                  </button>
                </div>
                {judgeTesting.msg && (
                  <div className={'llm-ep-msg' + (judgeTesting.ok ? ' ok' : ' bad')}>{judgeTesting.msg}</div>
                )}
              </div>

              {/* 多端点资源池（可选）：折叠区，配置后覆盖上方单端点，提供路由+熔断+故障转移 */}
              <div className="llm-ep">
                <button type="button" className="llm-ep-toggle" onClick={() => setShowPool((v) => !v)}>
                  <Icon name={showPool ? 'chevronDown' : 'chevronRight'} size={13} />
                  <span>多端点资源池</span>
                  <span className="llm-ep-badge">{endpoints.length ? `${endpoints.length} 个端点` : '可选'}</span>
                </button>
                {showPool && (
                  <div className="llm-ep-body">
                    <div className="llm-hint" style={{ marginBottom: 8 }}>
                      配置多个网关后，请求按「最少在途×权重」自动路由，连续失败自动熔断并转移；留空则仅用上方单端点。
                    </div>
                    {endpoints.length === 0 && (
                      <div className="llm-ep-empty">暂无端点，点下方「添加端点」开始配置</div>
                    )}
                    {endpoints.map((ep, i) => {
                      const st = epTesting[ep.id] || {}
                      const ph = poolById[ep.id]
                      return (
                        <div className={'llm-ep-row' + (ep.enabled === false ? ' off' : '')} key={ep.id}>
                          <div className="llm-ep-row-head">
                            <span className="llm-ep-idx">#{i + 1}</span>
                            <button type="button"
                              className={'llm-reason-toggle' + (ep.enabled !== false ? ' on' : '')}
                              onClick={() => setEp(ep.id, { enabled: ep.enabled === false })}
                              title="启用/停用该端点">
                              <span className="llm-reason-text">{ep.enabled !== false ? '启用' : '停用'}</span>
                              <span className="llm-reason-track"><span className="llm-reason-thumb" /></span>
                            </button>
                            {ph && (
                              <span className={'llm-ep-health' + (ph.cooling ? ' cooling' : (ph.fails ? ' warn' : ' ok'))}>
                                {ph.cooling ? `熔断中 ${Math.ceil((ph.cooldownMsLeft || 0) / 1000)}s`
                                  : `在途${ph.inflight || 0}·失败${ph.fails || 0}`}
                              </span>
                            )}
                            <button type="button" className="llm-ep-del" onClick={() => removeEndpoint(ep.id)} title="删除">
                              <Icon name="close" size={13} />
                            </button>
                          </div>
                          <input className="wl-input auth-input" placeholder="Base URL，如 https://gateway/v1"
                            value={ep.baseUrl || ''} spellCheck={false}
                            onChange={(e) => setEp(ep.id, { baseUrl: e.target.value })} />
                          <div className="llm-ep-row2">
                            <input className="wl-input auth-input" type="password" spellCheck={false}
                              placeholder={ep.hasKey ? `已保存（${ep.apiKeyMask || '****'}），留空沿用` : 'API Key'}
                              value={ep.apiKey || ''}
                              onChange={(e) => setEp(ep.id, { apiKey: e.target.value })} />
                            <input className="wl-input auth-input llm-ep-weight" type="number" min="1" step="1"
                              title="权重（越大分到越多请求）" placeholder="权重"
                              value={ep.weight ?? 1}
                              onChange={(e) => setEp(ep.id, { weight: Number(e.target.value) || 1 })} />
                            <button type="button" className="btn llm-ep-verify" disabled={st.busy}
                              onClick={() => verifyEndpoint(ep)}>
                              <Icon name={st.busy ? 'refresh' : 'bolt'} size={13} className={st.busy ? 'spin' : ''} />
                              验证
                            </button>
                          </div>
                          {st.msg && <div className={'llm-ep-msg' + (st.ok ? ' ok' : ' bad')}>{st.msg}</div>}
                        </div>
                      )
                    })}
                    <button type="button" className="llm-ep-add" onClick={addEndpoint}>
                      <Icon name="plus" size={13} /> 添加端点
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 2：分工——按【端点】分别设置各角色模型 */}
          {step === 2 && (
            <div className="llm-pane">
              <div className="llm-hint" style={{ marginBottom: 10 }}>
                {poolMode
                  ? `资源池已启用。下方只配置对话、操盘军师和智能体；Judge 已在上一步使用独立端点，不再作为资源池角色。附加端点某角色留空，表示该端点不承接该角色。`
                  : `为通用 AI 能力分别指定模型${listable ? `（共 ${modelList.length} 个可选）` : '（手动填写模型名）'}。Judge 已单独配置。`}
              </div>
              {/* 有已配置但被停用的端点 → 说明为何没在下方列出,引导回上一步启用 */}
              {disabledEndpoints().length > 0 && (
                <div className="llm-hint llm-hint-warn" style={{ marginBottom: 10 }}>
                  <Icon name="info" size={12} /> 另有 {disabledEndpoints().length} 个端点处于「停用」状态,不参与分发,故未在此列出。如需为其单独设模型,请回「上一步」把对应端点切到「启用」。
                </div>
              )}

              {/* 端点卡片:主端点 + 各资源池端点 */}
              {cardEndpoints().map((card) => {
                const info = epModels[card.id]
                const epList = info && info.models && info.models.length ? info.models : modelList
                return (
                  <div className={'llm-epcard' + (card.isMain ? ' main' : '')} key={card.id}>
                    <div className="llm-epcard-head">
                      <span className="llm-epcard-tag">{card.isMain ? <Icon name="star" size={12} /> : <Icon name="layers" size={12} />}{card.label}</span>
                      <span className="llm-epcard-host">{card.host}</span>
                      {info && info.listable && <span className="llm-epcard-count">{info.models.length} 模型</span>}
                      {info && info.ok === false && <span className="llm-epcard-count bad">验证失败</span>}
                      {info && info.ok === null && <span className="llm-epcard-count warn">未列举</span>}
                    </div>
                    {Object.keys(roles).map((k) => (
                      <div className="llm-eprole" key={k}>
                        <div className="llm-eprole-head">
                          <label>{roles[k].label || k}</label>
                          <button type="button"
                            className={'llm-reason-toggle' + (cardReason(card, k) ? ' on' : '')}
                            onClick={() => setCardReason(card, k, !cardReason(card, k))}
                            title="开启后该角色在本端点调用支持推理的模型时启用深度思考(reasoning),响应更慎密但更慢">
                            <span className="llm-reason-text"><Icon name="brain" size={12} /> 深度思考 <em className="llm-reason-state">{cardReason(card, k) ? '已开' : '关'}</em></span>
                            <span className="llm-reason-track"><span className="llm-reason-thumb" /></span>
                          </button>
                        </div>
                        <input className="wl-input auth-input" list={`llm-model-list-${card.id}`} spellCheck={false}
                          placeholder={card.isMain ? roles[k].def : '留空=该端点不承接此角色'}
                          value={cardModel(card, k)}
                          onChange={(e) => setCardModel(card, k, e.target.value)} />
                        <datalist id={`llm-model-list-${card.id}`}>
                          {epList.map((m) => <option key={m} value={m} />)}
                        </datalist>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          {/* Step 3：测试 */}
          {step === 3 && (
            <div className="llm-pane">
              {busy && !testResults && (
                <div className="llm-testing"><Icon name="refresh" size={14} className="spin" /> 正在逐个测试模型可用性…</div>
              )}
              {testResults && (
                <>
                  <div className="llm-hint" style={{ marginBottom: 8 }}>
                    {okCount}/{testResults.length} 个模型可用
                  </div>
                  <div className="llm-results">
                    {testResults.map((r) => (
                      <div className={'llm-result' + (r.ok ? ' ok' : ' bad')} key={`${r.target || '通用'}-${r.model}`}>
                        <Icon name={r.ok ? 'check' : 'close'} size={13} />
                        <span className="llm-result-model">{r.target ? `${r.target} · ` : ''}{r.model}</span>
                        <span className="llm-result-meta">{r.ok ? `${r.ms}ms` : (r.error || '不可用')}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {err && <div className="err llm-msg">{err}</div>}
          {notice && <div className="llm-msg ok">{notice}</div>}
        </div>

        {/* 底部操作 */}
        <div className="llm-actions">
          {step > 1
            ? <button className="btn" onClick={() => { setErr(''); setNotice(''); setStep(step - 1) }} disabled={busy}>上一步</button>
            : <span />}
          {step === 1 && (
            <button className="btn btn-primary" onClick={verifyAndNext} disabled={busy}>
              <Icon name={busy ? 'refresh' : 'check'} size={14} className={busy ? 'spin' : ''} />
              {busy ? '验证中…' : '验证并继续'}
            </button>
          )}
          {step === 2 && (
            <button className="btn btn-primary" onClick={testAndNext} disabled={busy}>
              <Icon name="gauge" size={14} /> 测试可用性
            </button>
          )}
          {step === 3 && (
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              <Icon name={busy ? 'refresh' : 'check'} size={14} className={busy ? 'spin' : ''} />
              {busy ? '保存中…' : '完成并保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
