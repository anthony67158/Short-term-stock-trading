import {
  buildOpportunityScoreInput,
  unavailableOpportunityScore,
} from '../shared/opportunityScoreContract.js'
import {
  buildOpportunityShadowFeatures,
} from '../shared/opportunityShadowFeatures.js'
import { fetchOpportunityScores } from './_opportunity_score.js'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function beijingTradeDate(timestamp) {
  return new Date(Number(timestamp) + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 10)
}

function marketRiskTier(marketEnv = {}) {
  if (marketEnv.allowRiskIncrease !== true) return 'BLOCKED'
  return marketEnv.weak === true ? 'CAUTIOUS' : 'STANDARD'
}

export async function loadAdvisorOpportunityScore({
  code,
  name = '',
  formula,
  decision,
  payload = {},
  candles = [],
  trends = [],
  now = Date.now(),
  scoreOpportunities = fetchOpportunityScores,
} = {}) {
  const normalizedCode = String(code || '')
  if (
    !/^\d{6}$/.test(normalizedCode)
    || decision?.positionMode !== 'UNOWNED'
    || decision?.priceContractValid !== true
    || !decision?.formulaId
  ) return null

  const event = {
    decisionId:
      `advisor:${beijingTradeDate(now)}:${normalizedCode}:`
      + `${decision.formulaId}`,
    asOf: Number(now),
    code: normalizedCode,
    name: String(name || '').slice(0, 60),
    mode: payload.todayQuote?.live === true ? 'INTRADAY' : 'CLOSE',
    stageReached: 'EVIDENCE',
    displayedRank: null,
    cheapScore: null,
    quote: payload.todayQuote || {},
    formulaEvaluations: (
      Array.isArray(formula?.evaluations)
        ? formula.evaluations
        : []
    ).map((item) => ({
      formulaId: String(item?.formulaId || ''),
      matched: item?.matched === true,
      score: finite(item?.score),
      priceType: String(item?.priceType || '') || null,
      blockers: Array.isArray(item?.blockers)
        ? item.blockers.map(String).slice(0, 8)
        : [],
    })),
    shadowFeatures: buildOpportunityShadowFeatures({
      quote: payload.todayQuote,
      candles,
      trends,
      fund: payload.stockFund,
      sectorOpportunity: payload.sectorOpportunity,
    }),
    decision,
    sector: {
      code: String(
        payload.sectorOpportunity?.sector?.code || '',
      ),
      name: String(
        payload.sectorOpportunity?.sector?.name || '',
      ),
      phase:
        payload.sectorOpportunity?.sector?.phase || null,
      actionability:
        payload.sectorOpportunity?.sector?.actionability || null,
    },
  }
  const batch = {
    mode: event.mode,
    slot: 'manual',
    marketGate: {
      allowed: payload.marketEnv?.allowRiskIncrease === true,
      riskTier: marketRiskTier(payload.marketEnv),
    },
  }
  let input
  try {
    input = buildOpportunityScoreInput({ event, batch })
  } catch {
    return null
  }

  let score
  try {
    const scores = await scoreOpportunities([input])
    score = scores?.get(normalizedCode)
      || unavailableOpportunityScore(input, 'MISSING_RESPONSE')
  } catch {
    score = unavailableOpportunityScore(
      input,
      'SERVICE_UNAVAILABLE',
    )
  }
  return {
    ...score,
    serverVerified: true,
    priceContract: {
      entryPrice: finite(decision.primaryPrice),
      stopPrice: finite(decision.stopPrice),
      targetPrice: finite(decision.targetPrice),
    },
  }
}
