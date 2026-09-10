import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  canonicalLlmRole,
  publicView,
} from '../api/_llm_config.js'
import { endpointsForRole } from '../api/_llm_pool.js'

test('Judge旧角色只作为解释池迁移别名', () => {
  assert.equal(canonicalLlmRole('judge'), 'explain')
  const config = {
    roleEndpoints: {
      explain: [{
        baseUrl: 'https://explain.example/v1',
        apiKey: 'explain-key',
        model: 'explain-model',
        enabled: true,
      }],
    },
  }
  assert.equal(
    endpointsForRole(config, 'judge')[0].role,
    'explain',
  )
})

test('公开配置不再暴露Judge角色', () => {
  const view = publicView()
  assert.equal(view.roleEndpoints.judge, undefined)
  assert.equal(view.judgeEndpoint, undefined)
})

test('交易确认实现不再调用LLM Judge', () => {
  const source = readFileSync(
    new URL('../api/_confirm.js', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /callChat/)
  assert.doesNotMatch(source, /getModel\('judge'\)/)
  assert.doesNotMatch(source, /role:\s*'judge'/)
  assert.match(source, /fuseConfirmation\(\{[\s\S]*?llm:\s*null/)
})
