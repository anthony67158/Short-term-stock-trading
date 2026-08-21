import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  resolveSectorEndpoint,
} from '../api/_llm_config.js'
import {
  endpointsForRole,
} from '../api/_llm_pool.js'

const frontend = readFileSync(
  new URL('../src/components/LLMConfig.jsx', import.meta.url),
  'utf8',
)

test('板块前瞻只路由到独立端点且不占用军师资源池', () => {
  const config = {
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: {
      advisor: 'advisor-main',
      sector: 'legacy-sector',
    },
    endpoints: [{
      id: 'advisor-backup',
      baseUrl: 'https://advisor.example/v1',
      apiKey: 'advisor-key',
      models: { advisor: 'advisor-backup' },
    }],
    sectorEndpoint: {
      baseUrl: 'https://sector.example/v1',
      apiKey: 'sector-key',
      model: 'sector-deep',
      reasoning: true,
      enabled: true,
    },
  }

  const sector = endpointsForRole(config, 'sector')
  const advisor = endpointsForRole(config, 'advisor')

  assert.equal(sector.length, 1)
  assert.equal(sector[0].id, 'sector-dedicated')
  assert.equal(sector[0].models.sector, 'sector-deep')
  assert.equal(
    advisor.some((endpoint) =>
      endpoint.baseUrl === 'https://sector.example/v1'),
    false,
  )
})

test('旧版资源池中的sector模型可迁移为独立端点', () => {
  const endpoint = resolveSectorEndpoint({
    baseUrl: 'https://main.example/v1',
    apiKey: 'main-key',
    models: { sector: 'sector-main' },
    reasoning: { sector: true },
    endpoints: [{
      id: 'sector-old',
      baseUrl: 'https://sector.example/v1',
      apiKey: 'sector-key',
      models: { sector: 'sector-pool' },
      reasoning: { sector: true },
    }],
  })

  assert.deepEqual(endpoint, {
    baseUrl: 'https://sector.example/v1',
    apiKey: 'sector-key',
    model: 'sector-pool',
    reasoning: true,
    enabled: true,
    source: 'legacy-pool',
  })
})

test('模型配置页提供板块前瞻专用端点', () => {
  assert.match(frontend, /板块前瞻专用端点/)
  assert.match(frontend, /sectorEndpoint/)
  assert.match(frontend, /target:\s*'sector'/)
})
