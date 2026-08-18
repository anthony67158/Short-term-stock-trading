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

test('通用主端点与附加端点可按ID复用已保存Key', () => {
  assert.deepEqual(
    resolveLlmConfigTarget(config, {
      endpointId: 'default',
      baseUrl: 'https://main.example/v1',
      apiKey: '',
    }),
    {
      endpointId: 'default',
      baseUrl: 'https://main.example/v1',
      apiKey: 'main-secret',
    },
  )
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

test('已保存Key不得复用于任意外部Base URL', () => {
  assert.deepEqual(
    resolveLlmConfigTarget(config, {
      endpointId: 'default',
      baseUrl: 'https://attacker.example/v1',
      apiKey: '',
    }),
    {
      endpointId: 'default',
      baseUrl: 'https://attacker.example/v1',
      apiKey: '',
    },
  )
  assert.match(
    resolveLlmConfigTarget(config, {
      endpointId: 'missing-endpoint',
    }).error,
    /不存在/,
  )
})

test('模型测试预算至少120秒且FC显式声明可用持仓模型', () => {
  assert.equal(MODEL_TEST_TIMEOUT_MS, 120000)
  assert.match(serverless, /PORTFOLIO_MODEL:\s*DeepSeek-V4-Pro/)
})

test('配置页使用endpointId验证已保存Key并逐端点测试资源池', () => {
  assert.match(frontend, /endpointId:\s*t\.id/)
  assert.match(frontend, /endpointId:\s*ep\.id/)
  assert.match(frontend, /cardEndpoints\(\)/)
  assert.doesNotMatch(frontend, /已存 Key 无法在线验证/)
})
