import test from 'node:test'
import assert from 'node:assert/strict'

import { replayDecisionPacket } from '../backtest/decision/replay.mjs'
import { buildDecisionAction } from '../shared/decisionEnginePolicy.js'
import {
  buildDecisionReplayPacket,
  executeDecisionReplayPacket,
  projectDecisionReplayResult,
} from '../shared/decisionReplayPacket.js'

function input(patch = {}) {
  return {
    payload: {
      code: '600001',
      name: '测试股份',
      todayQuote: {
        price: 10,
        pct: 1.2,
        live: true,
        volumeRatio: 1.4,
      },
      holdQty: 0,
      account: {
        cash: 100000,
        totalAssets: 100000,
        position: 0,
        stockWeight: 0,
        maxStockWeight: 20,
        complete: true,
      },
      accountCircuitBreaker: {
        state: 'CLOSED',
        allowRiskIncrease: true,
      },
      market: { regime: 'STANDARD' },
      sectorOpportunity: { stage: 'STARTUP' },
      stockFund: { mainNetYi: 0.2, retailNetYi: -0.1 },
      evidenceIncomplete: false,
      missingEvidence: [],
      ...patch.payload,
    },
    plans: patch.plans || [{
      route: 'IMMEDIATE',
      entryPlan: { price: 10 },
      exitPlan: {
        hardStopPrice: 9,
        takeProfitPrice: 12,
      },
      riskReward: 2,
      opportunityScore: {
        state: 'READY',
        usagePolicy: 'DIRECT',
        serverVerified: true,
        pFill: 0.8,
        pWinGivenFill: 0.6,
        expectedNetR: 0.3,
        netRLowerBound: -0.8,
        expectedShortfall10: -1.2,
        modelVersion: 'decision-model.test',
      },
      targetPosition: {
        schemaVersion: 'target-position.v1',
        state: 'READY',
        recommendedLots: 3,
        selected: {
          opportunityNetAmount: 120,
        },
      },
    }],
    now: patch.now || 1_789_000_000_000,
  }
}

test('脱敏决策包只保留纯内核需要的最小账户事实', () => {
  const source = input({
    payload: {
      account: {
        cash: 100000,
        totalAssets: 100000,
        complete: true,
        nickname: '不应进入回放包',
        token: 'private-token-value',
        holdings: [{ code: '600001', lots: 9 }],
        transactions: [{ id: 'trade-private' }],
      },
      apiKey: 'private-api-key',
      market: {
        regime: 'STANDARD',
        accessToken: 'nested-private-token',
      },
    },
  })
  const packet = buildDecisionReplayPacket(source)
  const serialized = JSON.stringify(packet)

  assert.deepEqual(packet.input.payload.account, {
    cash: 100000,
    totalAssets: 100000,
    position: null,
    stockWeight: null,
    maxStockWeight: null,
    complete: true,
  })
  assert.doesNotMatch(serialized, /private-token-value/)
  assert.doesNotMatch(serialized, /private-api-key/)
  assert.doesNotMatch(serialized, /nested-private-token/)
  assert.doesNotMatch(serialized, /trade-private/)
  assert.doesNotMatch(serialized, /不应进入回放包/)
})

test('生产纯内核与回放适配器逐字段输出一致', () => {
  const source = input()
  const packet = buildDecisionReplayPacket(source)
  const production = executeDecisionReplayPacket(packet)
  const replay = replayDecisionPacket(structuredClone(packet))
  const direct = buildDecisionAction(source)

  assert.deepEqual(replay, production)
  assert.deepEqual(
    projectDecisionReplayResult(direct),
    {
      ...production.result,
      packetFingerprint: null,
    },
  )
  assert.equal(production.result.action, 'BUY')
  assert.equal(production.result.quantityLots, 3)
  assert.equal(production.result.prices.buy, 10)
  assert.deepEqual(production.result.blockerCodes, [])
})

test('回放包合同版本或内容被修改时失败关闭', () => {
  const packet = buildDecisionReplayPacket(input())
  const wrongVersion = structuredClone(packet)
  wrongVersion.contracts.policy = 'decision-engine-policy.old'
  assert.throws(
    () => replayDecisionPacket(wrongVersion),
    /DECISION_REPLAY_VERSION_MISMATCH:policy/,
  )

  const modified = structuredClone(packet)
  modified.input.payload.todayQuote.price = 10.5
  assert.throws(
    () => replayDecisionPacket(modified),
    /DECISION_REPLAY_FINGERPRINT_MISMATCH/,
  )
})

test('账户阻断原因保留在可复算结果中', () => {
  const source = input({
    payload: {
      account: {
        cash: 100000,
        totalAssets: 100000,
        complete: false,
      },
    },
  })
  const { result } = replayDecisionPacket(
    buildDecisionReplayPacket(source),
  )

  assert.equal(result.action, 'WAIT')
  assert.equal(result.quantityLots, 0)
  assert.deepEqual(result.blockerCodes, ['ACCOUNT_INCOMPLETE'])
  assert.equal(result.decisionReason, 'ENTRY_INELIGIBLE')
})
