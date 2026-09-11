import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ROLES } from '../api/_llm_config.js'
import {
  endpointsForRole,
  pickEndpoint,
} from '../api/_llm_pool.js'

const portfolioAnalysis = readFileSync(
  new URL('../api/portfolio_analysis.js', import.meta.url),
  'utf8',
)

const config = {
  roleEndpoints: {
    portfolio: [{
      baseUrl: 'https://portfolio.example/v1',
      apiKey: 'portfolio-key',
      model: 'portfolio-model',
      reasoning: true,
      enabled: true,
    }],
  },
}

test('LLM配置用解释角色承载组合诊断说明', () => {
  assert.deepEqual(ROLES.explain, {
    envs: [
      'EXPLAIN_MODEL',
      'ADVISOR_MODEL',
      'PORTFOLIO_MODEL',
      'REVIEW_MODEL',
    ],
    def: 'DeepSeek-V4-Pro',
    label: '决策与组合解释',
  })
})

test('旧portfolio端点迁移到explain角色', () => {
  const endpoints = endpointsForRole(config, 'portfolio')
  assert.deepEqual(
    endpoints.map((endpoint) => endpoint.id),
    ['explain-1'],
  )
  assert.equal(endpoints[0].baseUrl, 'https://portfolio.example/v1')
})

test('持仓分析选路使用解释池', () => {
  assert.equal(
    pickEndpoint(config, 1000, 'portfolio').id,
    'explain-1',
  )
})

test('持仓分析实现不再调用军师角色作为备用模型', () => {
  assert.doesNotMatch(portfolioAnalysis, /role:\s*'advisor'/)
  assert.doesNotMatch(portfolioAnalysis, /getModel\('advisor'\)/)
  assert.doesNotMatch(portfolioAnalysis, /fallbackModel/)
  assert.match(portfolioAnalysis, /role:\s*'explain'/)
  assert.match(portfolioAnalysis, /getModel\('explain'\)/)
})
