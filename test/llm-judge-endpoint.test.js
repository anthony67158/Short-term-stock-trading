import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveJudgeEndpoint } from '../api/_llm_config.js'
import { endpointsForRole } from '../api/_llm_pool.js'

test('Judge 只路由到独立端点，不再使用通用端点角色配置', () => {
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { advisor: 'advisor-main', judge: 'legacy-main-judge' },
    endpoints: [{
      id: 'ep1',
      baseUrl: 'https://pool.example/v1',
      apiKey: 'pool-key',
      models: { advisor: 'advisor-pool', judge: 'legacy-pool-judge' },
    }],
    judgeEndpoint: {
      baseUrl: 'https://judge.example/v1',
      apiKey: 'judge-key',
      model: 'judge-fast',
      reasoning: false,
      enabled: true,
    },
  }

  const judgeEndpoints = endpointsForRole(config, 'judge')
  const advisorEndpoints = endpointsForRole(config, 'advisor')

  assert.equal(judgeEndpoints.length, 1)
  assert.equal(judgeEndpoints[0].baseUrl, 'https://judge.example/v1')
  assert.equal(judgeEndpoints[0].models.judge, 'judge-fast')
  assert.equal(advisorEndpoints.some((endpoint) => endpoint.baseUrl === 'https://judge.example/v1'), false)
})

test('旧版主端点 Judge 模型自动迁移为独立端点配置', () => {
  const migrated = resolveJudgeEndpoint({
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { judge: 'legacy-judge' },
    reasoning: { judge: true },
    endpoints: [],
  })

  assert.deepEqual(migrated, {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    model: 'legacy-judge',
    reasoning: true,
    enabled: true,
    source: 'legacy-main',
  })
})

test('显式停用 Judge 专用端点后不回退通用资源池', () => {
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { judge: 'legacy-judge' },
    judgeEndpoint: {
      baseUrl: 'https://judge.example/v1',
      apiKey: 'judge-key',
      model: 'judge-fast',
      enabled: false,
    },
  }

  assert.deepEqual(endpointsForRole(config, 'judge'), [])
})
