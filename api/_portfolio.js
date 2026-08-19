// 服务端持仓 payload 适配层。账户计算由 shared/portfolioAccounting.js 单一实现，
// 浏览器与 FC 只保留各自签名适配，避免做T、T+1 和估值口径再次漂移。
import { portfolioExposureContext } from '../shared/portfolioExposure.js';
import {
  buildTActionContext,
  computePortfolio,
  computeTFlows,
  livePositionOf,
  tradeActivityContext,
  t1StatusOf,
} from '../shared/portfolioAccounting.js';
export {
  computePortfolio,
  computeTFlows,
  livePositionOf,
  t1StatusOf,
};

// account 上下文(与前端 adviceDaily.accountFrom 同口径)
export function accountFrom(portfolio, account) {
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
  };
}

// 构造【持仓个股】hold_advice 的 payload(与前端 buildHoldSpec 的 aiPayload 同口径)
export function buildHoldPayload(
  holding,
  code,
  name,
  portfolio,
  account,
  closed,
  nextTradeDay,
  quote = null,
  now = Date.now(),
) {
  const lp = livePositionOf(holding, code);
  let holdCost, holdQty, openTNet;
  if (lp) {
    holdCost = lp.costWithFees ?? lp.cost;
    holdQty = lp.qty;
    openTNet = lp.hasOpenT ? lp.tNetHands : 0;
  } else {
    const hs = (holding || []).filter((h) => h.code === code);
    let tNet = 0, baseCostValue = 0, baseQtySum = 0;
    for (const h of hs) {
      const rr = computeTFlows(h.tFlows);
      tNet += (rr.openBuy || 0) - (rr.openSell || 0);
      baseCostValue += (
        (h.buyPrice || 0) * (h.qty || 0) * 100
        + (Number(h.buyFee) || 0)
      );
      baseQtySum += (h.qty || 0);
    }
    holdCost = baseQtySum > 0
      ? +(baseCostValue / (baseQtySum * 100)).toFixed(3)
      : null;
    holdQty = 0; openTNet = tNet;
  }
  const currentPrice = Number(quote?.price) > 0 ? Number(quote.price) : null;
  const stockWeight = (() => {
    const positions = portfolio && portfolio.positions
      ? portfolio.positions.filter((x) => x.code === code)
      : [];
    if (!positions.length) return null;
    return +positions.reduce((sum, position) => sum + (Number(position.weight) || 0), 0).toFixed(1);
  })();
  // T+1 买入时间锁定字段(与前端 t1Fields 同口径)
  let t1 = {};
  try {
    const st = t1StatusOf(holding, closed, code, now);
    if (st) {
      t1 = {
        boughtTodayQty: st.boughtToday,
        sellableTodayQty: st.sellableToday != null ? st.sellableToday : holdQty,
        t1Locked: st.boughtToday > 0,
        todayBuys: (st.buys || []).map((b) => ({ price: b.price, qty: b.qty, kind: b.kind })),
        ...(nextTradeDay ? { nextTradeDay } : {}),
      };
    }
  } catch { /* ignore */ }
  return {
    code, name, holdCost, holdQty, openTNet, currentPrice,
    ...t1,
    tradeContext: tradeActivityContext(closed, code),
    tContext: buildTActionContext(holding, closed, code, now),
    account: { ...accountFrom(portfolio, account), stockWeight },
  };
}

// 构造【自选/非持仓个股】buy_advice 的 payload(与前端 buildWatchSpec 的 aiPayload 同口径)
export function buildWatchPayload(code, name, portfolio, account) {
  return { code, name, account: accountFrom(portfolio, account) };
}
