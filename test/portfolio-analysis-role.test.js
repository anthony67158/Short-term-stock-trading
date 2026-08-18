import test from 'node:test'
import assert from 'node:assert/strict'

import { ROLES } from '../api/_llm_config.js'
import {
  endpointsForRole,
  pickEndpoint,
  resetPoolHealthForTests,
  markStart,
} from '../api/_llm_pool.js'

const config = {
  baseUrl: 'https://main.example/v1',
  apiKey: 'main-key',
  models: {
    portfolio: 'portfolio-main',
  },
  reasoning: {
    portfolio: true,
  },
  primaryMaxInflight: 2,
  endpoints: [
    {
      id: 'backup-a',
      baseUrl: 'https://backup-a.example/v1',
      apiKey: 'backup-a-key',
      models: { portfolio: 'portfolio-a' },
      weight: 2,
      enabled: true,
    },
    {
      id: 'backup-no-role',
      baseUrl: 'https://backup-b.example/v1',
      apiKey: 'backup-b-key',
      models: { advisor: 'advisor-b' },
      enabled: true,
    },
  ],
}

test('LLM配置公开持仓分布分析专用角色', () => {
  assert.deepEqual(ROLES.portfolio, {
    envs: ['PORTFOLIO_MODEL'],
    def: 'DeepSeek-V4-Pro',
    label: '持仓分布分析',
  })
})

test('持仓分析只路由到配置了portfolio模型的端点', () => {
  const endpoints = endpointsForRole(config, 'portfolio')
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.id),
    ['default', 'backup-a'],
  )
})

test('主端点未达并发阈值时优先，达到阈值后自动分流备用端点', () => {
  resetPoolHealthForTests()
  assert.equal(pickEndpoint(config, 1000, 'portfolio').id, 'default')
  markStart('default')
  assert.equal(pickEndpoint(config, 1000, 'portfolio').id, 'default')
  markStart('default')
  assert.equal(pickEndpoint(config, 1000, 'portfolio').id, 'backup-a')
})
