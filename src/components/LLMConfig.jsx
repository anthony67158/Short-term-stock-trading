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

  // 角色 & 模型
  const [roles, setRoles] = useState({})           // { chat:{label,def}, ... }
  const [models, setModels] = useState({})         // { chat:'x', advisor:'y', ... }
  const [modelList, setModelList] = useState([])   // 可选模型清单（来自 verify）
  const [listable, setListable] = useState(false)  // 端点是否支持 /models 列举

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
        setModels({ ...(c.models || {}) })
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

  // —— Step 1 → 2：验证连接、拉取模型清单 ——
  const verifyAndNext = async () => {
    setErr(''); setNotice('')
    if (!baseUrl.trim()) { setErr('请填写 Base URL'); return }
    if (!apiKey.trim() && !hasKey) { setErr('请填写 API Key'); return }
    setBusy(true)
    try {
      const j = await callConfig('verify', { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      if (!j || !j.ok) { setErr((j && j.error) || 'API Key 或 Base URL 无效'); setBusy(false); return }
      const list = Array.isArray(j.models) ? j.models : []
      setModelList(list)
      setListable(!!j.listable)
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
    const chosen = Object.values(models).filter(Boolean)
    if (!chosen.length) { setErr('请至少为一个角色选择模型'); return }
    setStep(3)
    setBusy(true)
    try {
      const j = await callConfig('test', { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), models: chosen })
      if (!j) { setErr('测试请求失败'); setBusy(false); return }
      setTestResults(Array.isArray(j.results) ? j.results : [])
      if (!j.ok) setNotice('部分模型不可用，可返回上一步更换后再测；或直接保存（不影响可用模型）')
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
      const j = await callConfig('save', { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), models })
      if (!j || !j.ok) { setErr((j && j.error) || '保存失败'); setBusy(false); return }
      setNotice('已保存，全系统即时生效')
      setTimeout(() => close(), 800)
    } catch (e) {
      setErr('保存失败：' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const setModel = (role, v) => setModels((prev) => ({ ...prev, [role]: v }))
  const okCount = testResults ? testResults.filter((r) => r.ok).length : 0

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
            </div>
          )}

          {/* Step 2：分工 */}
          {step === 2 && (
            <div className="llm-pane">
              <div className="llm-hint" style={{ marginBottom: 10 }}>
                为系统各处 AI 分别指定模型{listable ? `（共 ${modelList.length} 个可选）` : '（手动填写模型名）'}
              </div>
              {Object.keys(roles).map((k) => (
                <div className="llm-field" key={k}>
                  <label>{roles[k].label || k}</label>
                  <input className="wl-input auth-input" list="llm-model-list" spellCheck={false}
                    placeholder={roles[k].def} value={models[k] || ''}
                    onChange={(e) => setModel(k, e.target.value)} />
                </div>
              ))}
              <datalist id="llm-model-list">
                {modelList.map((m) => <option key={m} value={m} />)}
              </datalist>
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
                      <div className={'llm-result' + (r.ok ? ' ok' : ' bad')} key={r.model}>
                        <Icon name={r.ok ? 'check' : 'close'} size={13} />
                        <span className="llm-result-model">{r.model}</span>
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
