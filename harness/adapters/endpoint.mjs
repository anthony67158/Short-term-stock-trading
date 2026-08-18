import {
  currentConfig,
  ensureConfig,
} from '../../api/_llm_config.js'
import {
  endpointsForRole,
  modelForEndpoint,
} from '../../api/_llm_pool.js'

const ALLOWED_CAPABILITIES = new Set([
  'models',
  'chat',
  'function',
  'stream',
  'reasoning',
])

function safeError(value, sensitiveValues = []) {
  let text = String(value || '')
  for (const secret of sensitiveValues) {
    if (secret) text = text.split(String(secret)).join('[REDACTED]')
  }
  return text
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .slice(0, 160)
}

function hostOf(value) {
  try {
    return new URL(value).host
  } catch {
    return 'invalid'
  }
}

async function request(
  fetchImpl,
  url,
  init,
  timeoutMs,
  sensitiveValues = [],
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    })
    return {
      response,
      ms: Date.now() - startedAt,
      elapsedMs: () => Date.now() - startedAt,
      cleanup: () => clearTimeout(timer),
    }
  } catch (error) {
    clearTimeout(timer)
    return {
      response: null,
      ms: Date.now() - startedAt,
      error: safeError(
        error?.name || error?.message || error,
        sensitiveValues,
      ),
    }
  }
}

async function probeModels(fetchImpl, endpoint, model, timeoutMs) {
  const result = await request(
    fetchImpl,
    `${endpoint.baseUrl}/models`,
    {
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
    },
    timeoutMs,
    [endpoint.apiKey],
  )
  let payload = null
  if (result.response) {
    try {
      payload = await result.response.json()
    } catch {
      payload = null
    } finally {
      result.cleanup?.()
    }
  }
  const models = (payload?.data || payload?.models || [])
    .map((item) =>
      typeof item === 'string' ? item : item?.id || item?.name
    )
    .filter(Boolean)
  return {
    ok: !!result.response?.ok && models.includes(model),
    status: result.response?.status || 0,
    ms: result.elapsedMs?.() ?? result.ms,
    hasModel: models.includes(model),
    modelCount: models.length,
    ...(result.error ? { error: result.error } : {}),
  }
}

function completionBody(model, capability) {
  const base = {
    model,
    messages: [{
      role: 'user',
      content: capability === 'function'
        ? 'Call the tool.'
        : 'Reply only OK.',
    }],
    temperature: 0,
    max_tokens: capability === 'function' ? 256 : 128,
  }
  if (capability === 'function') {
    base.tools = [{
      type: 'function',
      function: {
        name: 'get_portfolio_snapshot',
        description: 'Read portfolio snapshot.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    }]
    base.tool_choice = 'required'
  }
  if (capability === 'stream') base.stream = true
  if (capability === 'reasoning') base.reasoning_effort = 'high'
  return base
}

async function probeCompletion(
  fetchImpl,
  endpoint,
  model,
  capability,
  timeoutMs,
) {
  const result = await request(
    fetchImpl,
    `${endpoint.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(completionBody(model, capability)),
    },
    timeoutMs,
    [endpoint.apiKey],
  )
  if (!result.response) {
    return {
      ok: false,
      status: 0,
      ms: result.ms,
      error: result.error || 'request failed',
      tokens: 0,
    }
  }
  if (capability === 'stream') {
    const body = await result.response.text()
      .catch(() => '')
      .finally(() => result.cleanup?.())
    return {
      ok: result.response.ok
        && body.includes('data:')
        && body.length > 0,
      status: result.response.status,
      ms: result.elapsedMs?.() ?? result.ms,
      bytes: Buffer.byteLength(body),
      tokens: 0,
    }
  }
  const payload = await result.response.json()
    .catch(() => null)
    .finally(() => result.cleanup?.())
  const message = payload?.choices?.[0]?.message || {}
  const toolNames = (message.tool_calls || [])
    .map((item) => item?.function?.name)
    .filter(Boolean)
  const hasContent = !!String(
    message.content || message.reasoning_content || '',
  ).trim()
  const ok = capability === 'function'
    ? toolNames.includes('get_portfolio_snapshot')
    : hasContent
  return {
    ok: result.response.ok && ok,
    status: result.response.status,
    ms: result.elapsedMs?.() ?? result.ms,
    tokens: Number(payload?.usage?.total_tokens) || 0,
    ...(capability === 'function' ? { toolNames } : { hasContent }),
    ...(!result.response.ok
      ? {
          error: safeError(
            payload?.error?.message || 'HTTP error',
            [endpoint.apiKey],
          ),
        }
      : {}),
  }
}

function check(id, dimension, passed, message, options = {}) {
  return {
    id,
    dimension,
    passed: passed === true,
    message,
    hard: options.hard === true,
    code: options.code,
    details: options.details ?? null,
  }
}

export async function runEndpointHarnessCase(
  testCase,
  {
    config: suppliedConfig,
    fetchImpl = fetch,
  } = {},
) {
  if (!suppliedConfig) await ensureConfig({ maxAgeMs: 0 })
  const config = suppliedConfig || currentConfig()
  const input = testCase.input || {}
  const expected = testCase.expect || {}
  const role = String(input.role || '')
  const timeoutMs = Math.max(
    1000,
    Math.min(300000, Number(input.timeoutMs) || 120000),
  )
  const requested = (input.capabilities || [])
    .filter((item) => ALLOWED_CAPABILITIES.has(item))
  const endpoints = endpointsForRole(config, role)
  const rows = await Promise.all(endpoints.map(async (endpoint) => {
    const model = modelForEndpoint(
      config,
      endpoint,
      role,
      config.models?.[role],
    )
    const capabilities = {}
    for (const capability of requested) {
      capabilities[capability] = capability === 'models'
        ? await probeModels(
            fetchImpl,
            endpoint,
            model,
            Math.min(timeoutMs, 30000),
          )
        : await probeCompletion(
            fetchImpl,
            endpoint,
            model,
            capability,
            timeoutMs,
          )
    }
    return {
      id: endpoint.id,
      host: hostOf(endpoint.baseUrl),
      model,
      capabilities,
    }
  }))
  const failedCapabilities = rows.flatMap((row) =>
    Object.entries(row.capabilities)
      .filter(([, result]) => !result.ok)
      .map(([capability]) => `${row.id}:${capability}`)
  )
  const latencies = rows.flatMap((row) =>
    Object.values(row.capabilities).map((item) => Number(item.ms) || 0)
  )
  const totalTokens = rows.reduce(
    (sum, row) =>
      sum + Object.values(row.capabilities).reduce(
        (inner, item) => inner + Number(item.tokens || 0),
        0,
      ),
    0,
  )
  const duplicateIds = rows
    .map((row) => row.id)
    .filter((id, index, all) => all.indexOf(id) !== index)
  const maxLatency = latencies.length ? Math.max(...latencies) : 0
  const serializedRows = JSON.stringify(rows)
  const secretLeak = endpoints.some((endpoint) =>
    endpoint.apiKey && serializedRows.includes(String(endpoint.apiKey))
  )
  const checks = [
    check(
      'endpoint-count',
      'contract',
      rows.length >= Number(expected.minEndpoints || 1),
      '可用端点数量不足',
      {
        hard: true,
        code: 'ENDPOINT_COUNT_LOW',
        details: rows.length,
      },
    ),
    check(
      'endpoint-identity',
      'contract',
      duplicateIds.length === 0
        && rows.every((row) => row.host !== 'invalid' && row.model),
      '端点身份或模型配置无效',
      { hard: true, code: 'ENDPOINT_IDENTITY_INVALID' },
    ),
    check(
      'endpoint-model-list',
      'groundedness',
      rows.every((row) =>
        !requested.includes('models')
        || row.capabilities.models?.hasModel === true
      ),
      '端点模型列表不包含配置模型',
      { hard: true, code: 'ENDPOINT_MODEL_MISSING' },
    ),
    check(
      'endpoint-secret-redaction',
      'groundedness',
      !secretLeak
        && !serializedRows.includes('apiKey')
        && !serializedRows.includes('Bearer '),
      '端点输出泄露凭证',
      { hard: true, code: 'ENDPOINT_SECRET_LEAK' },
    ),
    check(
      'endpoint-capabilities',
      'feasibility',
      failedCapabilities.length === 0,
      '端点能力探针失败',
      {
        hard: true,
        code: 'ENDPOINT_CAPABILITY_FAILED',
        details: failedCapabilities,
      },
    ),
    check(
      'endpoint-function-calling',
      'feasibility',
      !requested.includes('function')
        || rows.every((row) =>
          row.capabilities.function?.toolNames?.includes(
            'get_portfolio_snapshot',
          )
        ),
      'Function Calling未返回要求的工具',
      { hard: true, code: 'ENDPOINT_FUNCTION_INVALID' },
    ),
    check(
      'endpoint-latency-budget',
      'actionability',
      maxLatency <= Number(expected.maxLatencyMs || timeoutMs),
      '端点延迟超过预算',
      {
        hard: true,
        code: 'ENDPOINT_LATENCY_BUDGET_EXCEEDED',
        details: { maxLatency },
      },
    ),
    check(
      'endpoint-token-budget',
      'actionability',
      totalTokens <= Number(expected.maxTotalTokens || 100000),
      '端点探针Token超过预算',
      {
        hard: true,
        code: 'ENDPOINT_TOKEN_BUDGET_EXCEEDED',
        details: { totalTokens },
      },
    ),
    check(
      'endpoint-role-model',
      'consistency',
      rows.every((row) => !!row.model),
      '角色与端点模型映射不完整',
      { hard: true, code: 'ENDPOINT_ROLE_MODEL_MISSING' },
    ),
    check(
      'endpoint-stream-consistency',
      'consistency',
      !requested.includes('stream')
        || rows.every((row) => row.capabilities.stream?.bytes > 0),
      '流式能力返回空响应',
      { hard: true, code: 'ENDPOINT_STREAM_EMPTY' },
    ),
  ]
  return {
    output: {
      role,
      endpointCount: rows.length,
      endpoints: rows,
    },
    checks,
    metrics: {
      endpointCount: rows.length,
      failedCapabilityCount: failedCapabilities.length,
      maxLatencyMs: maxLatency,
      totalTokens,
    },
  }
}
