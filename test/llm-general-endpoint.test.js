import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  MODEL_TEST_TIMEOUT_MS,
  resolveLlmConfigTarget,
} from '../api/llm_config.js'

const frontend = readFileSync(
  new URL('../src/components/LLMConfig.jsx', import.meta.url),
  'utf8',
)
const serverless = readFileSync(
  new URL('../s.yaml', import.meta.url),
  'utf8',
)

const config = {
  baseUrl: 'https://main.example/v1',
  apiKey: 'main-secret',
  endpoints: [
    {
      id: 'backup-a',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'backup-secret',
      enabled: true,
    },
  ],
  judgeEndpoint: {
    baseUrl: 'https://judge.example/v1',
    apiKey: 'judge-secret',
    model: 'judge-model',
    enabled: true,
  },
}

const roleConfig = {
  roleEndpoints: {
    advisor: [{
      id: 'legacy-custom-id',
      baseUrl: 'https://advisor.example/v1',
      apiKey: 'advisor-secret',
      model: 'advisor-model',
      enabled: true,
    }],
  },
}

test('角色端点可按角色和槽位复用已保存Key', () => {
  assert.deepEqual(
    resolveLlmConfigTarget(roleConfig, {
      role: 'advisor',
      slot: 1,
      baseUrl: 'https://advisor.example/v1',
      apiKey: '',
    }),
    {
      endpointId: 'advisor-1',
      baseUrl: 'https://advisor.example/v1',
      apiKey: 'advisor-secret',
    },
  )
})

test('尚未保存的合法角色槽位可用新连接验证', () => {
  assert.deepEqual(
    resolveLlmConfigTarget(roleConfig, {
      role: 'advisor',
      slot: 2,
      baseUrl: 'https://advisor-2.example/v1',
      apiKey: 'advisor-2-secret',
    }),
    {
      endpointId: 'advisor-2',
      baseUrl: 'https://advisor-2.example/v1',
      apiKey: 'advisor-2-secret',
    },
  )
})

test('已保存Key不得复用于任意外部Base URL', () => {
  assert.deepEqual(
    resolveLlmConfigTarget(roleConfig, {
      role: 'advisor',
      slot: 1,
      baseUrl: 'https://other.example/v1',
      apiKey: '',
    }),
    {
      endpointId: 'advisor-1',
      baseUrl: 'https://other.example/v1',
      apiKey: '',
    },
  )
  assert.match(
    resolveLlmConfigTarget(roleConfig, {
      role: 'advisor',
      slot: 3,
    }).error,
    /槽位/,
  )
})

test('旧版端点验证契约在迁移期仍可复用已保存Key', () => {
  assert.deepEqual(
    resolveLlmConfigTarget(config, {
      endpointId: 'backup-a',
      apiKey: '',
    }),
    {
      endpointId: 'backup-a',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'backup-secret',
    },
  )
})

test('模型测试预算至少120秒且FC显式声明可用持仓模型', () => {
  assert.equal(MODEL_TEST_TIMEOUT_MS, 120000)
  assert.match(serverless, /PORTFOLIO_MODEL:\s*DeepSeek-V4-Pro/)
})

test('配置页按角色和槽位验证、测试各自端点', () => {
  assert.match(frontend, /role,\s*\n\s*slot:\s*index \+ 1/)
  assert.match(frontend, /roleEndpoints:\s*payload/)
  assert.match(frontend, /verifyEndpoint\(role, index\)/)
  assert.doesNotMatch(frontend, /已存 Key 无法在线验证/)
})
