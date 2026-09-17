// 选股 Agent 精选 runner：在召回快照的候选池内，结合盘面(market_snapshot)、
// 三级资金(_stock_fund)与公告/新闻(_ai_search) 精选最佳可买股票，并给出买入策略与时机。
// 硬约束：Agent 只能选候选池内 code；不改排序分/不生成成交；缺失/超时明确不可用。
import {
  callChatWithRetry,
  llmReady,
  parseLLMJson,
} from './_llm.js'
import {
  ensureConfig,
  getModel,
} from './_llm_config.js'
import {
  fetchResilientStockFund,
} from './_stock_fund.js'
import {
  fetchAdvisorSearchBundle,
} from './_ai_search.js'
import {
  fetchMarketSnapshot,
} from './market.js'
import {
  STOCK_PICK_AGENT_MAX,
  normalizeStockPickAgentSelection,
  unavailableStockPickAgentSelection,
} from '../shared/stockPickAgent.js'

export const STOCK_PICK_AGENT_TIMEOUT_MS = 90_000
export const STOCK_PICK_AGENT_MAX_TOKENS = 700
const AGENT_INPUT_CANDIDATES = 8

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function text(value, maximum = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

// 盘面摘要：只取指数与广度，作为 Agent 的市场环境输入（来自盘面研究同源快照）。
function marketBrief(market = {}) {
  const indices = (Array.isArray(market?.indices) ? market.indices : [])
    .filter((item) => ['000001', '399001', '399006'].includes(String(item?.code || '')))
    .map((item) => ({
      name: text(item.name, 20),
      pct: finite(item.pct),
      mainNetYi: finite(item.mainInflow) == null ? null : +(finite(item.mainInflow) / 1e8).toFixed(2),
    }))
  const breadth = market?.breadth || {}
  return {
    indices,
    up: finite(breadth.up),
    down: finite(breadth.down),
    limitUp: finite(breadth.limitUp),
    amountYi: finite(breadth.amountYi),
  }
}

function stockFundBrief(fund = {}) {
  return {
    mainNetYi: finite(fund.mainNetYi),
    mainNetPct: finite(fund.mainNetPct),
    main5dYi: finite(fund.main5dYi),
    retailNetYi: finite(fund.retailNetYi),
  }
}

// 公告/新闻线索：官方公告可核验，联网新闻仅作未核验线索且过滤未来时间。
function newsBrief(search = {}, asOf = Date.now()) {
  const items = (Array.isArray(search?.items) ? search.items : [])
    .filter((item) => {
      const published = Date.parse(String(item?.publishedAt || item?.date || ''))
      return !Number.isFinite(published) || published <= asOf
    })
    .slice(0, 2)
    .map((item) => ({
      title: text(item.title, 120),
      src: text(item.src || '联网检索', 40),
      status: 'SEARCH_RESULT_UNVERIFIED',
    }))
  return { items, enabled: search?.enabled === true }
}

export async function buildStockPickAgentInput({
  snapshot,
  now = Date.now(),
  fetchMarket = fetchMarketSnapshot,
  fetchFund = fetchResilientStockFund,
  fetchSearch = fetchAdvisorSearchBundle,
} = {}) {
  const candidates = (Array.isArray(snapshot?.candidates) ? snapshot.candidates : [])
    .slice(0, AGENT_INPUT_CANDIDATES)
  if (!candidates.length) return { candidates: [] }
  const market = await fetchMarket().catch(() => ({}))
  const funds = await Promise.all(candidates.map((item) =>
    fetchFund(item.code, { preferRealtime: true, fetchedAt: now }).catch(() => null)
  ))
  const searches = await Promise.all(candidates.map((item) =>
    fetchSearch({
      code: item.code,
      name: item.name,
      industry: item.industry || '',
      reviewOrigin: 'manual',
      includeIndustry: false,
    }).catch(() => ({ items: [], enabled: false }))
  ))
  return {
    tradeDate: text(snapshot?.tradeDate, 16),
    market: marketBrief(market),
    candidates: candidates.map((item, index) => ({
      code: item.code,
      name: item.name,
      industry: item.industry,
      quote: {
        price: finite(item.quote?.price),
        pct: finite(item.quote?.pct),
        low: finite(item.quote?.low),
        high: finite(item.quote?.high),
        turnover: finite(item.quote?.turnover),
        volumeRatio: finite(item.quote?.volumeRatio),
      },
      ranking: item.ranking,
      recallReasons: item.recallReasons,
      fund: stockFundBrief(funds[index] || {}),
      news: newsBrief(searches[index], now),
    })),
  }
}

const SYSTEM_PROMPT = [
  '你是A股选股决策Agent。规则已完成全市场召回并给出候选池，你只负责在候选池内精选最佳可买股票。',
  '只能选择输入candidates中的code；不得新增股票、不得修改排序分或编造执行价。',
  '必须综合：市场盘面(market)、个股三级资金(fund)、量价(quote)、公告/新闻线索(news)。',
  '未核验新闻(SEARCH_RESULT_UNVERIFIED)只能作为线索，不能压过资金与量价事实。',
  '最多选3只；证据不足或优势不明确时可返回NO_SELECTION，禁止凑数。',
  '每只被选股票必须给出：买入策略(buyStrategy: entryPrice在当日价带内, positionPctMax≤10, plan分批说明)、',
  '时机推断(timing: trigger触发条件, window有效期, nextSession次日预案)、counterCase反方、invalidation失效条件。',
  '只输出JSON：{"conclusion":"SELECT|NO_SELECTION","overallReason":"...",',
  '"selections":[{"code":"...","rationale":"...",',
  '"buyStrategy":{"entryPrice":0,"positionPctMax":0,"plan":"..."},',
  '"timing":{"trigger":"...","window":"...","nextSession":"..."},',
  '"counterCase":"...","invalidation":"..."}],"limitations":["..."]}',
].join('\n')

export async function generateStockPickAgentSelection({
  snapshot,
  now = Date.now(),
  agentRunId = '',
  buildInput = buildStockPickAgentInput,
  ensureLlmConfig = ensureConfig,
  isLlmReady = llmReady,
  resolveModel = getModel,
  callLlm = callChatWithRetry,
} = {}) {
  const input = await buildInput({ snapshot, now })
  if (!input.candidates.length) {
    return unavailableStockPickAgentSelection({
      reasonCode: 'NO_CANDIDATE',
      reason: '当前召回候选为空',
      now,
    })
  }
  await ensureLlmConfig()
  if (!isLlmReady('assistant')) {
    return unavailableStockPickAgentSelection({
      reasonCode: 'AGENT_NOT_CONFIGURED',
      reason: '选股 Agent 端点未配置',
      now,
    })
  }
  const model = resolveModel('assistant')
  const routed = await callLlm({
    model,
    role: 'assistant',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input) },
    ],
    temperature: 0.1,
    maxTokens: STOCK_PICK_AGENT_MAX_TOKENS,
    timeoutMs: STOCK_PICK_AGENT_TIMEOUT_MS,
    headerTimeoutMs: 15_000,
    responseFormat: { type: 'json_object' },
    forceNoReason: true,
  }, { retries: 0, budgetLeftMs: STOCK_PICK_AGENT_TIMEOUT_MS })

  const { resp, done = () => {} } = routed
  if (resp?.__err) {
    done(false)
    return unavailableStockPickAgentSelection({
      reasonCode: resp.__err.name === 'AbortError' ? 'AGENT_TIMEOUT' : 'AGENT_ERROR',
      reason: resp.__err.name === 'AbortError' ? '选股 Agent 响应超时' : '选股 Agent 服务异常',
      now,
    })
  }
  if (!resp?.ok) {
    done(false)
    return unavailableStockPickAgentSelection({
      reasonCode: 'AGENT_ERROR',
      reason: `选股 Agent 服务返回${resp?.status || 0}`,
      now,
    })
  }
  const body = await resp.json().catch(() => null)
  const parsed = parseLLMJson(body?.choices?.[0]?.message?.content || '')
  if (!parsed.value || parsed.repaired) {
    done(false)
    return unavailableStockPickAgentSelection({
      reasonCode: 'AGENT_RESPONSE_INVALID',
      reason: '选股 Agent 返回内容不完整',
      now,
    })
  }
  done(true)
  return normalizeStockPickAgentSelection(parsed.value, {
    candidateSet: input.candidates,
    agentModel: routed.selectedModel || model,
    agentRunId,
    now,
  })
}

export { STOCK_PICK_AGENT_MAX }
