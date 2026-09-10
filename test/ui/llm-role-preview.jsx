import ReactDOM from 'react-dom/client'
import '../../tokens.css'
import '../../src/styles.css'
import '../../src/styles/precision.css'
import LLMConfig from '../../src/components/LLMConfig.jsx'

if (!import.meta.env.DEV) throw new Error('Local fixture only')

const roles = {
  explain: {
    def: 'DeepSeek-V4-Pro',
    label: 'V3决策与组合解释',
  },
  assistant: {
    def: 'Qwen3-Max-A',
    label: '智能体助手(需函数调用)',
  },
  daily: {
    def: 'Qwen3-Max-A',
    label: '策略日报',
  },
  sector: {
    def: 'gpt-5.6-terra',
    label: '板块前瞻',
  },
}
const roleSlots = {
  explain: 2,
  assistant: 1,
  daily: 1,
  sector: 1,
}
const roleEndpoints = Object.fromEntries(
  Object.entries(roleSlots).map(([role, count]) => [
    role,
    Array.from({ length: count }, (_, index) => ({
      id: `${role}-${index + 1}`,
      role,
      slot: index + 1,
      baseUrl: `https://${role}-${index + 1}.example/v1`,
      apiKeyMask: 'key****demo',
      hasKey: true,
      model: roles[role].def,
      reasoning: role === 'sector',
      enabled: true,
      source: 'fixture',
    })),
  ]),
)
const pool = Object.values(roleEndpoints).flat().map((endpoint) => ({
  id: endpoint.id,
  role: endpoint.role,
  slot: endpoint.slot,
  baseUrl: endpoint.baseUrl,
  inflight: 0,
  fails: 0,
  latencyMs: 120,
  latencySamples: 3,
  cooling: false,
  cooldownMsLeft: 0,
}))

window.fetch = async (input) => {
  const url = new URL(
    typeof input === 'string' ? input : input.url,
    location.origin,
  )
  if (url.pathname !== '/api/llm_config') {
    throw new Error('External network blocked in fixture')
  }
  return new Response(JSON.stringify({
    ok: true,
    roles,
    roleSlots,
    pool,
    concurrency: 4,
    config: {
      roleEndpoints,
      source: 'fixture',
      updatedAt: Date.now(),
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <LLMConfig />,
)
