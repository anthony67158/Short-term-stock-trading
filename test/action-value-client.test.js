import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTION_VALUE_TIMEOUT_MS,
  fetchDecisionScores,
} from '../api/_action_value_client.js'
import {
  OPPORTUNITY_SCORE_FEATURE_NAMES,
  OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
  OPPORTUNITY_SCORE_SCHEMA_VERSION,
} from '../shared/opportunityScoreContract.js'

function input(code = '600001') {
  return {
    schemaVersion: OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
    asOf: 1_788_320_000_000,
    code,
    formulaId: 'INTRADAY_VWAP_PULLBACK',
    factors: Object.fromEntries(
      OPPORTUNITY_SCORE_FEATURE_NAMES.map((name) => [name, 0]),
    ),
  }
}

test('生产动作价值为集成模型冷启动保留八秒预算', () => {
  assert.equal(ACTION_VALUE_TIMEOUT_MS, 8_000)
})

test('量化服务未配置时为每只候选返回NOT_READY', async () => {
  const scores = await fetchDecisionScores(
    [input(), input('600002')],
    { env: {}, fetchImpl: async () => assert.fail('不应请求网络') },
  )

  assert.equal(scores.size, 2)
  assert.equal(scores.get('600001').state, 'NOT_READY')
  assert.equal(scores.get('600001').pFill, null)
})

test('决策评分使用独立端点并校验响应合同', async () => {
  let request = null
  const scores = await fetchDecisionScores([input()], {
    env: {
      QUANT_URL: 'https://quant.example.com/',
      QUANT_KEY: 'test-key',
    },
    fetchImpl: async (url, options) => {
      request = { url, options }
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            predictions: [{
              schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
              state: 'READY',
              modelVersion: 'opportunity-score.20260902',
              code: '600001',
              formulaId: 'INTRADAY_VWAP_PULLBACK',
              pFill: 0.7,
              pWinGivenFill: 0.6,
              expectedNetR: 0.2,
              netRLowerBound: 0.05,
              expectedShortfall10: -1.1,
              calibration: {
                method: 'sigmoid+sigmoid',
                sampleCount: 400,
                bucket: 'STANDARD:ACCUMULATION:INTRADAY_OPEN',
              },
              engine: {
                stateEncoder: 'state-encoder.tree-v1',
                router: 'action-router.tree-v1',
                heads: {
                  entry: 'entry-head.adapter-v1',
                  portfolio: 'portfolio-heads.tree-v1',
                },
              },
              taskValues: {
                schemaVersion: 'decision-task-values.v1',
                selection: {
                  rankingScore: 0.7,
                  expectedOpportunityR: 0.2,
                },
                entry: { expectedNetR: 0.14, pFill: 0.7 },
                portfolio: {
                  schemaVersion: 'portfolio-action-values.v1',
                  addRelativeToHoldR: 0.2,
                  holdR: 0.2,
                  reduceRelativeToHoldR: -0.1,
                  exitRelativeToHoldR: -0.2,
                  addExecutionAdjustedR: 0.14,
                  source: 'CURRENT_PRODUCTION_HEAD_ADAPTER',
                },
                execution: { pFill: 0.7 },
                risk: { q10R: 0.05, cvarR: -1.1 },
                review: {
                  recompute: true,
                  source: 'DETERMINISTIC_FALLBACK',
                },
              },
              outOfDistribution: false,
            }],
          }
        },
      }
    },
  })

  assert.equal(
    request.url,
    'https://quant.example.com/decision-score',
  )
  assert.equal(request.options.headers['X-API-Key'], 'test-key')
  assert.equal(
    JSON.parse(request.options.body).items.length,
    1,
  )
  assert.equal(scores.get('600001').pFill, 0.7)
  assert.equal(
    scores.get('600001').taskValues.portfolio.holdR,
    0.2,
  )
  assert.equal(
    scores.get('600001').engine.router,
    'action-router.tree-v1',
  )
})

test('超时或非法响应只降级影子评分而不抛出', async () => {
  const scores = await fetchDecisionScores([input()], {
    env: { QUANT_URL: 'https://quant.example.com' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          predictions: [{
            schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
            state: 'READY',
            code: '600001',
            formulaId: 'INTRADAY_VWAP_PULLBACK',
            pFill: 9,
          }],
        }
      },
    }),
  })

  assert.equal(scores.get('600001').state, 'NOT_READY')
  assert.equal(scores.get('600001').reason, 'INVALID_RESPONSE')
})
