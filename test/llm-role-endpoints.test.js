import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ROLE_ENDPOINT_SLOTS,
  ROLES,
  roleEndpointSlots,
  resolveRoleEndpoints,
} from '../api/_llm_config.js'
import {
  endpointCountForRole,
  endpointsForRole,
} from '../api/_llm_pool.js'

const frontend = readFileSync(
  new URL('../src/components/LLMConfig.jsx', import.meta.url),
  'utf8',
)
const dailyReport = readFileSync(
  new URL('../api/daily_report.js', import.meta.url),
  'utf8',
)
const ai = readFileSync(
  new URL('../api/ai.js', import.meta.url),
  'utf8',
)
const agent = readFileSync(
  new URL('../api/agent.js', import.meta.url),
  'utf8',
)
const sector = readFileSync(
  new URL('../api/_sector_forecast_llm.js', import.meta.url),
  'utf8',
)

test('实际LLM能力收敛为四个角色和五个固定端点槽位', () => {
  assert.deepEqual(Object.keys(ROLES), [
    'explain',
    'assistant',
    'daily',
    'sector',
  ])
  assert.deepEqual(ROLE_ENDPOINT_SLOTS, {
    explain: 2,
    assistant: 1,
    daily: 1,
    sector: 1,
  })
})

test('每个角色只路由到自己的专用端点', () => {
  const roleEndpoints = Object.fromEntries(
    Object.entries(ROLE_ENDPOINT_SLOTS).map(([role, count]) => [
      role,
      Array.from({ length: count }, (_, index) => ({
        id: 'shared-id',
        baseUrl: `https://${role}-${index + 1}.example/v1`,
        apiKey: `${role}-key-${index + 1}`,
        model: `${role}-model-${index + 1}`,
        reasoning: role === 'explain',
        enabled: true,
      })),
    ]),
  )
  const config = { roleEndpoints }

  for (const role of Object.keys(ROLES)) {
    const endpoints = endpointsForRole(config, role)
    assert.equal(endpoints.length, ROLE_ENDPOINT_SLOTS[role])
    assert.ok(endpoints.every((endpoint) => endpoint.role === role))
    assert.deepEqual(
      endpoints.map((endpoint) => endpoint.id),
      Array.from(
        { length: ROLE_ENDPOINT_SLOTS[role] },
        (_, index) => `${role}-${index + 1}`,
      ),
    )
    assert.ok(endpoints.every((endpoint) =>
      endpoint.baseUrl.includes(role)))
  }
  assert.equal(endpointCountForRole(config, 'explain'), 2)
  assert.equal(endpointCountForRole(config, 'assistant'), 1)
})

test('旧版主端点和资源池可无损迁移到角色端点槽位', () => {
  const legacy = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: {
      chat: 'chat-model',
      advisor: 'advisor-main',
      portfolio: 'portfolio-model',
      agent: 'agent-model',
      sector: 'sector-model',
      judge: 'judge-model',
    },
    reasoning: { advisor: true },
    endpoints: [{
      id: 'advisor-backup',
      baseUrl: 'https://advisor-backup.example/v1',
      apiKey: 'advisor-backup-key',
      models: { advisor: 'advisor-backup-model' },
    }],
  }

  assert.deepEqual(
    resolveRoleEndpoints(legacy, 'explain').map((endpoint) => ({
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
    })),
    [{
      baseUrl: 'https://main.example/v1',
      model: 'advisor-main',
    }, {
      baseUrl: 'https://advisor-backup.example/v1',
      model: 'advisor-backup-model',
    }],
  )
  assert.equal(
    resolveRoleEndpoints(legacy, 'assistant')[0].model,
    'agent-model',
  )
})

test('旧配置缺少的固定槽位以停用状态补齐', () => {
  const migrated = roleEndpointSlots({
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { advisor: 'advisor-main' },
  }, 'explain')

  assert.equal(migrated.length, 2)
  assert.equal(migrated[0].enabled, true)
  assert.equal(migrated[1].id, 'explain-2')
  assert.equal(migrated[1].enabled, false)
  assert.equal(migrated[1].model, ROLES.explain.def)
})

test('旧advisor和agent配置迁移为解释与助手角色', () => {
  const legacy = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { advisor: 'advisor-main' },
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://advisor.example/v1',
        apiKey: 'advisor-key',
        model: 'advisor-model',
        enabled: true,
      }],
    },
  }

  assert.equal(resolveRoleEndpoints(legacy, 'explain')[0].model, 'advisor-model')
  assert.equal(resolveRoleEndpoints(legacy, 'advisor')[0].role, 'explain')
})

test('旧advisor空槽按顺序由portfolio补齐且不复制重复端点', () => {
  const legacy = {
    roleEndpoints: {
      advisor: [{
        baseUrl: 'https://advisor.example/v1',
        apiKey: 'advisor-key',
        model: 'advisor-model',
      }, {
        model: 'unused-placeholder',
        enabled: false,
      }],
      portfolio: [{
        baseUrl: 'https://portfolio.example/v1',
        apiKey: 'portfolio-key',
        model: 'portfolio-model',
      }],
      review: [{
        baseUrl: 'https://advisor.example/v1',
        apiKey: 'advisor-key',
        model: 'advisor-model',
      }],
    },
  }

  assert.deepEqual(
    resolveRoleEndpoints(legacy, 'explain').map((endpoint) => ({
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
    })),
    [{
      baseUrl: 'https://advisor.example/v1',
      model: 'advisor-model',
    }, {
      baseUrl: 'https://portfolio.example/v1',
      model: 'portfolio-model',
    }],
  )
})

test('策略日报使用独立daily角色而不是复用agent', () => {
  assert.match(dailyReport, /getModel\('daily'\)/)
  assert.match(dailyReport, /role:\s*'daily'/)
  assert.match(dailyReport, /forceNoReason:\s*true/)
})

test('各入口按自己的角色判断专用端点是否可用', () => {
  assert.match(ai, /llmReady\(useRole\)/)
  assert.match(ai, /llmRoleForAdviceMode\(/)
  assert.doesNotMatch(ai, /getModel\('chat'\)/)
  assert.match(agent, /llmReady\('assistant'\)/)
  assert.match(dailyReport, /llmReady\('daily'\)/)
})

test('复杂生成统一使用有界推理且工具规划不启用深度思考', () => {
  assert.match(agent, /reasoning:\s*boundedReasoning/)
  assert.match(agent, /reasoningEffort:\s*'medium'/)
  assert.match(agent, /forceNoReason:\s*!boundedReasoning/)
  assert.match(sector, /reasoningEffort:\s*'medium'/)
  assert.match(sector, /timeoutMs:\s*90000/)
})

test('配置界面按角色展示端点且不再暴露通用资源池', () => {
  assert.match(frontend, /'explain'/)
  assert.match(frontend, /'assistant'/)
  assert.match(frontend, /roleEndpoints/)
  assert.match(frontend, /V3决策与组合解释/)
  assert.match(frontend, /ROLE_ORDER\.length/)
  assert.match(frontend, /role !== 'explain'/)
  assert.doesNotMatch(frontend, /'judge'/)
  assert.doesNotMatch(frontend, /'review'/)
  assert.doesNotMatch(frontend, /对话\/盘面分析/)
  assert.match(frontend, /`端点 \$\{index \+ 1\}`/)
  assert.doesNotMatch(frontend, /多端点资源池/)
  assert.doesNotMatch(frontend, /主端点最大在途/)
})

test('配置读取验证测试和保存请求都有前端超时保护', () => {
  assert.match(frontend, /new AbortController\(\)/)
  assert.match(frontend, /CONFIG_REQUEST_TIMEOUT_MS/)
  assert.match(frontend, /signal:\s*controller\.signal/)
})
