// 浏览器端军师批量任务构造器。
// 持仓与自选共用这里的载荷口径，自动调度由 FC cron_advice 负责：
//   持仓股 → mode='hold_advice'(加/减/持/清 + 具体价位,含账户/目标资产/做T净手数上下文)
//   自选股 → mode='buy_advice'(立即买入/回调再买/小仓试错/观望 四档),二者内容差异由后端 prompt 区分。
import { api } from './apiBase'
import { planStore, livePositionOf, computeTFlows, t1StatusOf } from './planStore'
import { currentQuantModelVersion, quantModelQuery } from './quantModel'
import { portfolioExposureContext } from '../shared/portfolioExposure.js'
import { adviceTrustBands } from '../shared/adviceIntelligence.js'
import { nextTradingDayLabel } from '../shared/tradingCalendar.js'
import { tradeActivityContext } from '../shared/portfolioAccounting.js'

// 军师历史战绩(真实回测胜率)→ 传后端做自我校准(与 StockDetail.loadQuant 同口径)
function advisorTrackFor(mode) {
  try {
    const s = planStore.adviceStats()
    if (!s || s.total < 5) return null
    const g = (s.groups || []).find((x) => x.mode === mode) || null
    let theoryScores = null
    try {
      const t = planStore.theoryStats()
      const tg = ((t && t.groups) || []).filter((x) => x.total >= 8)
      if (tg.length) theoryScores = tg.map((x) => ({ theory: x.theory, winRate: x.winRate, total: x.total, avgPct: x.avgPct }))
    } catch { /* ignore */ }
    const actionScores = (s.actions || [])
      .filter((x) => x.total >= 5)
      .map((x) => ({
        kind: x.kind,
        label: x.label,
        winRate: x.winRate,
        total: x.total,
        avgPct: x.avgPct,
      }))
    return {
      overallWinRate: s.winRate, overallAvgPct: s.avgPct, overallTotal: s.total,
      modeWinRate: g ? g.winRate : null, modeAvgPct: g ? g.avgPct : null, modeTotal: g ? g.total : 0,
      actionScores,
      theoryScores,
      trustBands: adviceTrustBands(s),
    }
  } catch { return null }
}

function accountFrom(portfolio, account) {
  return {
    totalAssets: (portfolio && portfolio.totalAssets) ?? (account && account.totalAssets) ?? null,
    cash: (portfolio && portfolio.available) ?? (account && account.cash) ?? null,
    position: portfolio && portfolio.position != null ? portfolio.position : null,
    holdMktValue: portfolio && portfolio.holdMktValue != null ? portfolio.holdMktValue : null,
    goal: portfolio && portfolio.goal != null ? portfolio.goal : null,
    goalProgress: portfolio && portfolio.goalProgress != null ? portfolio.goalProgress : null,
    goalGap: portfolio && portfolio.goalGap != null ? portfolio.goalGap : null,
    goalReturnPct: portfolio && portfolio.goalReturnPct != null ? portfolio.goalReturnPct : null,
    ...portfolioExposureContext(portfolio),
  }
}

// T+1 买入时间锁定字段:注入 aiPayload,让军师知道"今天买的手数当日不可卖"。
// boughtTodayQty=今日买入手数(建仓/加仓/今日做T买腿,T+1锁定); sellableTodayQty=今日最多可卖手数;
// t1Locked=true 表示存在今日买入(有锁定手数); nextTradeDay=真实下一交易日(锁定手数最早可卖日)。
function t1Fields(code, holdQty) {
  try {
    const t1 = t1StatusOf(code)
    if (!t1) return {}
    const sellable = t1.sellableToday != null ? t1.sellableToday : holdQty
    return {
      boughtTodayQty: t1.boughtToday,
      sellableTodayQty: sellable,
      t1Locked: t1.boughtToday > 0,
      todayBuys: (t1.buys || []).map((b) => ({ price: b.price, qty: b.qty, kind: b.kind })),
      nextTradeDay: nextTradingDayLabel(),
    }
  } catch { return {} }
}

// 生成【持仓个股】的 AI 操作建议(hold_advice):带成本/手数/做T净手数/账户占比/目标资产
// 只【构造 spec】,不直接发起 —— 供每日调度与「批量一次性生成」两条链路复用同一口径。
export function buildHoldSpec(code, name, quoteMap, portfolio, account) {
  const lp = livePositionOf(code)  // {qty,cost,hasOpenT,tNetHands} 或 null(底仓被反T卖光)
  let holdCost, holdQty, openTNet
  if (lp) {
    holdCost = lp.cost; holdQty = lp.qty; openTNet = lp.hasOpenT ? lp.tNetHands : 0
  } else {
    // 反T卖光未接回:用底仓成本作参考,holdQty=0,openTNet为负 → 让军师指导"接回/加仓"
    const hs = (planStore.get().holding || []).filter((h) => h.code === code)
    let tNet = 0, baseCostSum = 0, baseQtySum = 0
    for (const h of hs) {
      const rr = computeTFlows(h.tFlows)
      tNet += (rr.openBuy || 0) - (rr.openSell || 0)
      baseCostSum += (h.buyPrice || 0) * (h.qty || 0); baseQtySum += (h.qty || 0)
    }
    holdCost = baseQtySum > 0 ? +(baseCostSum / baseQtySum).toFixed(3) : null
    holdQty = 0; openTNet = tNet
  }
  const hp = (holdCost != null && holdQty != null) ? `&holdCost=${holdCost}&holdQty=${holdQty}` : ''
  const quantModelVersion = currentQuantModelVersion()
  const quantUrl = api(`/api/stock_detail?code=${code}&klt=101&lmt=60&quant=1${quantModelQuery()}${hp}&_t=${Date.now()}`)
  const stockWeight = (() => {
    const positions = portfolio && portfolio.positions
      ? portfolio.positions.filter((x) => x.code === code)
      : []
    if (!positions.length) return null
    return +positions.reduce((sum, position) => sum + (Number(position.weight) || 0), 0).toFixed(1)
  })()
  const aiPayload = {
    code, name,
    quantModelVersion,
    holdCost, holdQty,
    openTNet,
    tradeContext: tradeActivityContext(
      planStore.get().closed || [],
      code,
    ),
    // T+1 买入时间锁定：今日买入手数当日绝对不可卖(A股T+1)，今日最多可卖=可卖手数
    ...t1Fields(code, holdQty),
    advisorTrack: advisorTrackFor('hold_advice'),
    account: { ...accountFrom(portfolio, account), stockWeight },
  }
  const priceHint = (quoteMap && quoteMap[code] && quoteMap[code].price) || holdCost || null
  return { code, mode: 'hold_advice', name, myHold: true, aiPayload, quantUrl, priceHint }
}

// 生成【自选/非持仓个股】的 AI 操作建议(buy_advice):四档买点结论,不含持仓上下文
export function buildWatchSpec(code, name, quoteMap, portfolio, account) {
  const quantModelVersion = currentQuantModelVersion()
  const quantUrl = api(`/api/stock_detail?code=${code}&klt=101&lmt=60&quant=1${quantModelQuery()}&_t=${Date.now()}`)
  const aiPayload = {
    code, name,
    quantModelVersion,
    advisorTrack: advisorTrackFor('buy_advice'),
    account: accountFrom(portfolio, account),
  }
  const priceHint = (quoteMap && quoteMap[code] && quoteMap[code].price) || null
  return { code, mode: 'buy_advice', name, myHold: false, aiPayload, quantUrl, priceHint }
}
