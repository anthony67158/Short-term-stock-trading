import test from 'node:test'
import assert from 'node:assert/strict'

import { ROLES } from '../api/_llm_config.js'
import {
  endpointsForRole,
  pickEndpoint,
} from '../api/_llm_pool.js'

const config = {
  roleEndpoints: {
    portfolio: [{
      baseUrl: 'https://portfolio.example/v1',
      apiKey: 'portfolio-key',
      model: 'portfolio-model',
      reasoning: true,
      enabled: true,
    }],
    advisor: [{
      baseUrl: 'https://advisor.example/v1',
      apiKey: 'advisor-key',
      model: 'advisor-model',
      enabled: true,
    }],
  },
}

test('LLM配置公开持仓分布分析专用角色', () => {
  assert.deepEqual(ROLES.portfolio, {
    envs: ['PORTFOLIO_MODEL'],
    def: 'DeepSeek-V4-Pro',
    label: '持仓分布分析',
  })
})

test('持仓分析只路由到portfolio独立端点', () => {
  const endpoints = endpointsForRole(config, 'portfolio')
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.id),
    ['portfolio-1'],
  )
  assert.equal(endpoints[0].baseUrl, 'https://portfolio.example/v1')
  assert.equal(
    endpoints.some((endpoint) =>
      endpoint.baseUrl === 'https://advisor.example/v1'),
    false,
  )
})

test('持仓分析选路不会跨到其他角色端点', () => {
  assert.equal(
    pickEndpoint(config, 1000, 'portfolio').id,
    'portfolio-1',
  )
})
