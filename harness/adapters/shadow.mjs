import {
  currentConfig,
  ensureConfig,
} from '../../api/_llm_config.js'
import { parseLLMJson } from '../../api/_llm.js'
import {
  endpointsForRole,
  modelForEndpoint,
} from '../../api/_llm_pool.js'

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

function normalizeDecision(value, allowedCodes, allowedEvidenceIds) {
  if (!value || typeof value !== 'object') return null
  const decision = String(value.decision || '')
  const code = String(value.code || '')
  const targetWeightPct = Number(value.targetWeightPct)
  if (
    !['buy', 'add', 'reduce', 'exit', 'hold', 'wait'].includes(decision)
    || !allowedCodes.has(code)
    || !Number.isFinite(targetWeightPct)
    || targetWeightPct < 0
    || targetWeightPct > 100
  ) return null
  const rawEvidenceIds = [
    ...new Set(
      (Array.isArray(value.evidenceIds) ? value.evidenceIds : [])
        .map(String),
    ),
  ].slice(0, 20)
  const evidenceIds = rawEvidenceIds
    .filter((id) => allowedEvidenceIds.has(id))
    .slice(0, 8)
  const rejectedEvidenceIds = rawEvidenceIds.filter(
    (id) => !allowedEvidenceIds.has(id),
  )
  return {
    decision,
    code,
    targetWeightPct,
    reason: String(value.reason || '').slice(0, 300),
    trigger: String(value.trigger || '').slice(0, 240),
    evidenceIds,
    rejectedEvidenceIds,
  }
}

async function callShadow(
  fetchImpl,
  endpoint,
  model,
  prompt,
  timeoutMs,
  allowedCodes,
  allowedEvidenceIds,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(
      `${endpoint.baseUrl}/chat/completions`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are a shadow evaluator. Return only JSON and never execute actions.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: 800,
          response_format: { type: 'json_object' },
        }),
      },
    )
    const payload = await response.json().catch(() => null)
    const parsed = parseLLMJson(
      payload?.choices?.[0]?.message?.content || '',
    )
    const decision = normalizeDecision(
      parsed.value,
      allowedCodes,
      allowedEvidenceIds,
    )
    return {
      id: endpoint.id,
      host: hostOf(endpoint.baseUrl),
      model,
      ok: response.ok && !!decision,
      status: response.status,
      ms: Date.now() - startedAt,
      tokens: Number(payload?.usage?.total_tokens) || 0,
      decision,
      ...(response.ok
        ? {}
        : {
            error: safeError(
              payload?.error?.message || 'HTTP error',
              [endpoint.apiKey],
            ),
          }),
    }
  } catch (error) {
    return {
      id: endpoint.id,
      host: hostOf(endpoint.baseUrl),
      model,
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      tokens: 0,
      decision: null,
      error: safeError(
        error?.name || error?.message || error,
        [endpoint.apiKey],
      ),
    }
  } finally {
    clearTimeout(timer)
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

export async function runShadowHarnessCase(
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
    Math.min(300000, Number(input.timeoutMs) || 180000),
  )
  const allowedCodes = new Set(
    (input.allowedCodes || []).map(String),
  )
  const allowedEvidenceIds = new Set(
    (input.allowedEvidenceIds || []).map(String),
  )
  const endpoints = endpointsForRole(config, role)
  const responses = await Promise.all(endpoints.map((endpoint) => {
    const model = modelForEndpoint(
      config,
      endpoint,
      role,
      config.models?.[role],
    )
    return callShadow(
      fetchImpl,
      endpoint,
      model,
      String(input.prompt || ''),
      timeoutMs,
      allowedCodes,
      allowedEvidenceIds,
    )
  }))
  const valid = responses.filter((response) => response.ok)
  const signatures = new Map()
  for (const response of valid) {
    const signature = `${response.decision.decision}|${response.decision.code}`
    signatures.set(signature, (signatures.get(signature) || 0) + 1)
  }
  const majority = Math.max(0, ...signatures.values())
  const agreement = valid.length
    ? +(majority / valid.length).toFixed(4)
    : 0
  const unknownEvidence = valid.flatMap((response) =>
    response.decision.rejectedEvidenceIds || []
  )
  const maxLatencyMs = Math.max(
    0,
    ...responses.map((response) => response.ms),
  )
  const totalTokens = responses.reduce(
    (sum, response) => sum + response.tokens,
    0,
  )
  const checks = [
    check(
      'shadow-response-count',
      'contract',
      valid.length >= Number(expected.minResponses || 1),
      '影子对拍有效响应不足',
      {
        hard: true,
        code: 'SHADOW_RESPONSE_COUNT_LOW',
        details: { valid: valid.length, total: responses.length },
      },
    ),
    check(
      'shadow-json-contract',
      'contract',
      valid.every((response) => !!response.decision),
      '影子输出不符合结构化契约',
      { hard: true, code: 'SHADOW_CONTRACT_INVALID' },
    ),
    check(
      'shadow-code-whitelist',
      'groundedness',
      valid.every((response) =>
        allowedCodes.has(response.decision.code)
      ),
      '影子模型输出白名单外股票',
      { hard: true, code: 'SHADOW_CODE_NOT_ALLOWED' },
    ),
    check(
      'shadow-evidence-whitelist',
      'groundedness',
      unknownEvidence.length === 0,
      '影子模型引用未知证据',
      {
        hard: true,
        code: 'SHADOW_EVIDENCE_NOT_ALLOWED',
        details: unknownEvidence,
      },
    ),
    check(
      'shadow-weight-range',
      'feasibility',
      valid.every((response) =>
        response.decision.targetWeightPct >= 0
        && response.decision.targetWeightPct <= 100
      ),
      '影子目标权重越界',
      { hard: true, code: 'SHADOW_WEIGHT_INVALID' },
    ),
    check(
      'shadow-read-only',
      'feasibility',
      true,
      '影子对拍不得产生执行动作',
      { hard: true, code: 'SHADOW_EXECUTION_FORBIDDEN' },
    ),
    check(
      'shadow-actionable-fields',
      'actionability',
      valid.every((response) =>
        response.decision.reason
        && response.decision.trigger
      ),
      '影子结论缺少理由或复核触发器',
      { code: 'SHADOW_ACTIONABILITY_LOW' },
    ),
    check(
      'shadow-budget',
      'actionability',
      maxLatencyMs <= Number(expected.maxLatencyMs || timeoutMs)
        && totalTokens <= Number(expected.maxTotalTokens || 100000),
      '影子对拍超过延迟或Token预算',
      {
        hard: true,
        code: 'SHADOW_BUDGET_EXCEEDED',
        details: { maxLatencyMs, totalTokens },
      },
    ),
    check(
      'shadow-agreement',
      'consistency',
      agreement >= Number(expected.minAgreement || 0.67),
      '多端点影子结论一致率不足',
      {
        code: 'SHADOW_AGREEMENT_LOW',
        details: { agreement },
      },
    ),
    check(
      'shadow-model-attribution',
      'consistency',
      responses.every((response) =>
        response.id && response.host !== 'invalid' && response.model
      ),
      '影子结果缺少端点或模型归因',
      { hard: true, code: 'SHADOW_MODEL_ATTRIBUTION_MISSING' },
    ),
  ]
  return {
    output: {
      shadowOnly: true,
      actionable: false,
      role,
      agreement,
      responses,
    },
    checks,
    metrics: {
      endpointCount: responses.length,
      validResponseCount: valid.length,
      agreement,
      maxLatencyMs,
      totalTokens,
    },
  }
}
