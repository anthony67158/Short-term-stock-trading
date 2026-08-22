import { timingSafeEqual } from 'node:crypto'

import { applyCors, preflight } from './_lib.js'
import {
  authenticateAccountRequest,
} from './_account_auth.js'
import { writeAccount } from './account.js'
import {
  buildStrategyPromotionGate,
  CURRENT_STRATEGY_EVALUATION,
} from '../shared/strategyPromotionGate.js'
import {
  councilRecordsFromData,
} from '../shared/advisorCouncilStore.js'
import { getStrategyCatalogV2 } from '../shared/strategyCatalogV2.js'
import {
  buildDefaultStrategyGovernance,
  strategyCanInfluenceProduction,
} from '../shared/strategyGovernanceV2.js'

function secureEqual(left, right) {
  const expected = Buffer.from(String(right || ''))
  const actual = Buffer.from(String(left || ''))
  if (expected.length < 16 || actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function learningOf(data) {
  return data?.realOutcomeLearning || {
    schemaVersion: 'real-outcome-learning.v1',
    overall: { samples: 0 },
  }
}

export function strategyGovernanceSnapshot(
  data = {},
  evaluation = CURRENT_STRATEGY_EVALUATION,
) {
  const councilRecords = councilRecordsFromData(data)
  const gate = buildStrategyPromotionGate({
    evaluation,
    realOutcomeLearning: learningOf(data),
    councilRecords,
    humanApproval: data.strategyHumanApproval,
  })
  const catalog = getStrategyCatalogV2()
  const governance = buildDefaultStrategyGovernance(
    data.strategyGovernanceV2 || {},
  )
  const strategies = governance.strategies.map((record) => {
    const spec = catalog.strategies.find(
      (item) => item.strategyId === record.strategyId,
    )
    return {
      ...record,
      name: spec?.name || record.strategyId,
      purpose: spec?.purpose || null,
      eligibleRegimes: spec?.eligibleRegimes || [],
      signalTimeframe: spec?.signalTimeframe || null,
      executionTimeframe: spec?.executionTimeframe || null,
      productionEligible: strategyCanInfluenceProduction(record),
    }
  })
  return {
    schemaVersion: 'strategy-governance.v2',
    catalogVersion: catalog.catalogVersion,
    strategies,
    productionStrategies: strategies
      .filter((record) => record.productionEligible)
      .map((record) => record.strategyId),
    routingPolicy: {
      schemaVersion: 'strategy-route.v1',
      priority: [
        'HARD_EXIT',
        'RISK_REDUCTION',
        'POSITION_MANAGEMENT',
        'NEW_ENTRY',
        'T_OPTIMIZATION',
      ],
      recentProfitWeighting: false,
      minimumShadowSamplesForRanking: 30,
    },
    legacy: {
      schemaVersion: 'strategy-governance.v1',
    },
    evaluation,
    gate,
    realOutcome: learningOf(data).overall || { samples: 0 },
    council: {
      samples: councilRecords.length,
      latest: councilRecords.slice(0, 10).map((record) => ({
        code: record.code,
        name: record.name,
        mode: record.mode,
        at: record.at,
        evidenceSnapshotId: record.evidenceSnapshotId,
        baseAdviceAction: record.baseAdviceAction,
        consensusReached: record.compiled?.consensusReached === true,
        hardGatePassed: record.compiled?.hardGatePassed === true,
        blockers: (record.compiled?.blockers || []).slice(0, 12),
      })),
    },
    humanApproval: data.strategyHumanApproval || null,
  }
}

export function recordStrategyHumanApproval(
  data,
  {
    evaluation = CURRENT_STRATEGY_EVALUATION,
    suppliedKey,
    configuredKey,
    approvedBy,
    now = Date.now(),
  } = {},
) {
  if (!secureEqual(suppliedKey, configuredKey)) {
    return {
      ok: false,
      code: 'APPROVAL_UNAUTHORIZED',
      error: '人工批准授权失败',
    }
  }
  const candidate = {
    specVersion: evaluation.specVersion,
    approvedAt: now,
    approvedBy: String(approvedBy || '').slice(0, 80),
  }
  const gate = buildStrategyPromotionGate({
    evaluation,
    realOutcomeLearning: learningOf(data),
    councilRecords: councilRecordsFromData(data),
    humanApproval: candidate,
  })
  if (!gate.productionEligible) {
    return {
      ok: false,
      code: 'GATE_BLOCKED',
      error: '其他晋级门禁尚未全部通过，不能人工覆盖',
      gate,
    }
  }
  data.strategyHumanApproval = candidate
  return { ok: true, gate, approval: candidate }
}

function send(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.end(JSON.stringify(payload))
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  if (!['GET', 'POST'].includes(req.method)) {
    return send(res, 405, { ok: false, error: 'GET or POST only' })
  }
  const authentication = await authenticateAccountRequest(req)
  if (!authentication.ok || !authentication.account) {
    return send(res, 401, {
      ok: false,
      error: authentication.error || '账号鉴权失败',
    })
  }
  const account = authentication.account
  account.data = account.data || {}
  if (req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      governance: strategyGovernanceSnapshot(account.data),
    })
  }
  if (req.body?.action !== 'approve') {
    return send(res, 422, { ok: false, error: '不支持的治理操作' })
  }
  const result = recordStrategyHumanApproval(account.data, {
    suppliedKey: req.headers['x-strategy-approval-key'],
    configuredKey: process.env.STRATEGY_APPROVAL_KEY,
    approvedBy: account.nick,
  })
  if (!result.ok) {
    const status = result.code === 'APPROVAL_UNAUTHORIZED' ? 403 : 409
    return send(res, status, result)
  }
  await writeAccount(account)
  return send(res, 200, result)
}
