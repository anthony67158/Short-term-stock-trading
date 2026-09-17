// 选股召回数据层：全市场扫描 → 规则预筛 → 排序模型分(可缺失) → 归一化快照。
// 硬边界：全市场事实来自 fetchTailPickRealtimePool 的全池强校验结果；
// 排序分来自离线发布的决策模型(fetchDecisionScores)，缺失时回落规则召回分并标注。
// 不自动下单；不写交易事实；缺失明确不可用。

import {
  fetchTailPickRealtimePool,
} from './_tail_pick_data.js'
import {
  scoreCandidatesWithDecisionModel,
} from './_decision_candidate.js'
import {
  fetchMarketSnapshot,
} from './market.js'
import {
  buildMarketOpportunityContext,
} from '../shared/marketOpportunityContext.js'
import {
  beijingMinutes,
} from '../shared/tradingCalendar.js'
import {
  RANKING_SOURCE,
  STOCK_PICK_MAX_CANDIDATES,
  buildStockPickSnapshot,
  normalizeStockPickCandidate,
  ruleRecallScore,
  unavailableStockPickSnapshot,
} from '../shared/stockPick.js'

// 召回预筛：在全池实时预筛(passesTailPickRealtimePrefilter)之上，
// 取规则召回分最高的前 N*3 只送模型打分，避免对 5000 只全量打分。
const RECALL_SCORE_POOL = STOCK_PICK_MAX_CANDIDATES * 3

function pickRecallPool(list = []) {
  return [...list]
    .map((row) => ({ row, recall: ruleRecallScore(row) }))
    .sort((left, right) => right.recall.score - left.recall.score)
    .slice(0, RECALL_SCORE_POOL)
    .map((item) => item.row)
}

// 把决策模型评分结果映射为 code -> 最优路径分。
function modelScoreByCode(scored = []) {
  const map = new Map()
  for (const item of Array.isArray(scored) ? scored : []) {
    const code = String(item?.code || '')
    if (!/^\d{6}$/.test(code)) continue
    const best = (Array.isArray(item?.plans) ? item.plans : [])
      .map((plan) => plan?.opportunityScore)
      .filter((score) => score && score.state === 'READY')
      .sort((left, right) =>
        (Number(right?.rankingScore) || 0) - (Number(left?.rankingScore) || 0)
      )[0]
    if (best) map.set(code, best)
  }
  return map
}

export async function buildStockPickRecall({
  now = Date.now(),
  fetchPool = fetchTailPickRealtimePool,
  fetchMarket = fetchMarketSnapshot,
  scoreCandidates = scoreCandidatesWithDecisionModel,
  onProgress = () => {},
} = {}) {
  let pool
  try {
    pool = await fetchPool({ now })
  } catch (error) {
    return unavailableStockPickSnapshot({
      reasonCode: 'RECALL_UNIVERSE_INCOMPLETE',
      reason: String(error?.message || '全市场快照不完整'),
      now,
    })
  }
  const prefiltered = Array.isArray(pool?.list) ? pool.list : []
  const tradeDate = prefiltered[0]?.tradeDate || ''
  await Promise.resolve(onProgress({
    stage: 'RECALL',
    percent: 40,
    message: `全市场 ${pool?.total || 0} 只，预筛 ${prefiltered.length} 只候选`,
  }))
  if (!prefiltered.length) {
    return buildStockPickSnapshot({
      candidates: [],
      total: pool?.total || 0,
      inspected: pool?.inspectedCount || 0,
      tradeDate,
      now,
    })
  }

  const recallPool = pickRecallPool(prefiltered)
  await Promise.resolve(onProgress({
    stage: 'RANK',
    percent: 70,
    message: `对 ${recallPool.length} 只候选取排序模型分`,
  }))

  let scoreMap = new Map()
  let modelVersion = ''
  try {
    const market = await fetchMarket().catch(() => ({}))
    const marketContext = buildMarketOpportunityContext({ market })
    const scored = await scoreCandidates(recallPool, {
      mode: 'INTRADAY',
      slot: beijingMinutes(now),
      market,
      marketContext,
      now,
    })
    scoreMap = modelScoreByCode(scored)
    modelVersion = [...scoreMap.values()][0]?.modelVersion || ''
  } catch {
    scoreMap = new Map()
  }

  const candidates = recallPool.map((row) =>
    normalizeStockPickCandidate(row, {
      modelScore: scoreMap.get(String(row.code)) || null,
    })
  )
  const rankingSource = candidates.some((item) =>
    item.ranking?.source === RANKING_SOURCE.MODEL
  ) ? RANKING_SOURCE.MODEL : RANKING_SOURCE.RULE

  return buildStockPickSnapshot({
    candidates,
    total: pool?.total || 0,
    inspected: pool?.inspectedCount || 0,
    tradeDate,
    rankingSource,
    modelVersion,
    now,
  })
}
