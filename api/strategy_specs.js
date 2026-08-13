import { applyCors, preflight } from './_lib.js'
import {
  compileStrategySpec,
  createDefaultStrategySpec,
} from '../shared/strategySpec.js'

const STRATEGIES = [
  compileStrategySpec(createDefaultStrategySpec()),
]

export function strategySpecResponse(strategyId = '') {
  const id = String(strategyId || '').trim()
  if (!id) {
    return {
      status: 200,
      body: {
        ok: true,
        schemaVersion: 'strategy-catalog.v1',
        data: STRATEGIES,
      },
    }
  }
  const strategy = STRATEGIES.find((item) => item.strategyId === id)
  if (!strategy) {
    return {
      status: 404,
      body: { ok: false, error: '策略不存在' },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      schemaVersion: 'strategy-catalog.v1',
      strategy,
    },
  }
}

export default async function handler(req, res) {
  if (preflight(req, res)) return
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300')
  if (req.method !== 'GET') {
    return res.status(405).send(JSON.stringify({
      ok: false,
      error: 'GET only',
    }))
  }
  const response = strategySpecResponse(req.query?.strategyId)
  return res.status(response.status).send(JSON.stringify(response.body))
}
