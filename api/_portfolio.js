// 服务端【纯函数】持仓/做T/账户全景计算 —— 从前端 planStore.js 原样移植(去掉 React 依赖)。
// 供云端定时任务(cron_advice.js)在服务端复刻前端 buildHoldSpec/buildWatchSpec 的口径,
// 保证「电脑关了浏览器,云端定时生成的 AI 操作建议」与「用户手动/浏览器定时生成」完全同源同值。
// ⚠️ 只做纯计算,不碰网络/存储;若前端 planStore 的对应算法有变,这里需同步。
import { deriveAccountValuation } from '../shared/accountValuation.js';

// FIFO 配对做T流水:算未配平(挂单)净手数 + 开口腿均价(与 planStore.computeTFlows 同口径,只保留云端需要的字段)
export function computeTFlows(flows) {
  const list = [...(flows || [])].sort((a, b) => a.at - b.at);
  const queue = { buy: [], sell: [] };
  for (const f of list) {
    const opp = f.side === 'buy' ? 'sell' : 'buy';
    let remain = f.qty;
    let feeLeft = f.fee;
    while (remain > 0 && queue[opp].length) {
      const head = queue[opp][0];
      const m = Math.min(remain, head.qty);
      remain -= m;
      feeLeft -= feeLeft * (m / (remain + m));
      head.qty -= m;
      head.fee -= head.fee * (m / (head.qty + m));
      if (head.qty <= 1e-9) queue[opp].shift();
    }
    if (remain > 0) queue[f.side].push({ price: f.price, qty: remain, fee: feeLeft, at: f.at });
  }
  const openBuy = queue.buy.reduce((a, x) => a + x.qty, 0);
  const openSell = queue.sell.reduce((a, x) => a + x.qty, 0);
  const openBuyAmt = queue.buy.reduce((a, x) => a + x.price * x.qty * 100, 0);
  const openBuyAvg = openBuy ? +(openBuyAmt / (openBuy * 100)).toFixed(3) : null;
  const openBuyFee = +queue.buy.reduce((a, x) => a + x.fee, 0).toFixed(2);
  return { openBuy, openSell, openBuyAvg, openBuyFee };
}

// 某 code 的【实时持仓】(已并表反T):返回 {qty,cost,hasOpenT,tNetHands} 或 null(底仓被反T卖光)
export function livePositionOf(holding, code) {
  const hs = (holding || []).filter((h) => h.code === code);
  if (!hs.length) return null;
  let qty = 0, costSum = 0, hasOpenT = false, tNet = 0;
  for (const h of hs) {
    const baseQty = h.qty || 0, baseCost = h.buyPrice || 0;
    const r = computeTFlows(h.tFlows);
    const openBuy = r.openBuy || 0, openSell = r.openSell || 0;
    const net = openBuy - openSell;
    if (h.tFlows && h.tFlows.length && (openBuy > 0 || openSell > 0)) hasOpenT = true;
    tNet += net;
    const liveQty = Math.max(0, baseQty + net);
    let cost = baseCost;
    if (openBuy > 0 && r.openBuyAvg != null && (baseQty + openBuy) > 0) {
      cost = ((baseCost * baseQty) + (r.openBuyAvg * openBuy)) / (baseQty + openBuy);
    }
    qty += liveQty;
    costSum += cost * liveQty;
  }
  if (qty <= 0) return null;
  return { qty, cost: +(costSum / qty).toFixed(3), hasOpenT, tNetHands: tNet };
}

// 账户全景:传入 holding + 实时报价 quoteMap(按 code) + account,返回市值/浮盈/总资产/仓位/单票占比/目标派生
export function computePortfolio(holding, quoteMap, account) {
  const positions = (holding || []).map((h) => {
    const q = quoteMap && quoteMap[h.code];
    const price = q && Number(q.price) > 0 ? q.price
      : (q && Number(q.prevClose) > 0 ? Number(q.prevClose) : h.buyPrice);
    const baseQty = Number(h.qty) || 0;
    const tFlows = computeTFlows(h.tFlows);
    const liveQty = Math.max(0, baseQty + (tFlows.openBuy || 0) - (tFlows.openSell || 0));
    const shares = liveQty * 100;
    const mktValue = +(price * shares).toFixed(2);
    let costValue = (h.buyPrice || 0) * baseQty * 100 + (h.buyFee || 0);
    if (tFlows.openBuy > 0 && tFlows.openBuyAvg != null) {
      costValue += tFlows.openBuyAvg * tFlows.openBuy * 100 + (tFlows.openBuyFee || 0);
    } else if (tFlows.openSell > 0 && baseQty > 0) {
      costValue *= Math.max(0, baseQty - tFlows.openSell) / baseQty;
    }
    costValue = +costValue.toFixed(2);
    const floatPnl = +(mktValue - costValue).toFixed(2);
    const floatPct = costValue ? +((floatPnl / costValue) * 100).toFixed(2) : 0;
    return {
      id: h.id,
      code: h.code,
      name: h.name,
      qty: liveQty,
      baseQty,
      price,
      buyPrice: h.buyPrice,
      mktValue,
      costValue,
      floatPnl,
      floatPct,
    };
  });
  const holdMktValue = +positions.reduce((a, p) => a + p.mktValue, 0).toFixed(2);
  const holdCostValue = +positions.reduce((a, p) => a + p.costValue, 0).toFixed(2);
  const floatPnl = +(holdMktValue - holdCostValue).toFixed(2);
  const {
    cash,
    available,
    totalAssets,
    initialCapital,
    totalPnl,
    totalPnlPct,
  } = deriveAccountValuation({ holdMktValue, holdCostValue, account });
  const position = totalAssets ? +((holdMktValue / totalAssets) * 100).toFixed(1) : null;
  positions.forEach((p) => { p.weight = totalAssets ? +((p.mktValue / totalAssets) * 100).toFixed(1) : null; });
  const goal = account && account.goal != null && account.goal > 0 ? account.goal : null;
  let goalProgress = null, goalGap = null, goalReturnPct = null;
  if (goal && totalAssets != null) {
    goalProgress = +((totalAssets / goal) * 100).toFixed(1);
    goalGap = +(goal - totalAssets).toFixed(2);
    goalReturnPct = totalAssets > 0 ? +(((goal - totalAssets) / totalAssets) * 100).toFixed(1) : null;
  }
  return {
    positions,
    holdMktValue,
    holdCostValue,
    floatPnl,
    totalAssets,
    initialCapital,
    totalPnl,
    totalPnlPct,
    cash,
    available,
    position,
    goal,
    goalProgress,
    goalGap,
    goalReturnPct,
  };
}

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
  };
}

// 最近一个"北京时间零点"的时间戳(epoch ms)——纯 epoch 运算,不依赖运行时时区。
function bjDayStartTs() {
  const EIGHT_H = 8 * 3600000, DAY = 24 * 3600000;
  return Math.floor((Date.now() + EIGHT_H) / DAY) * DAY - EIGHT_H;
}

// T+1 买入时间锁定(与前端 planStore.t1StatusOf 同口径):今日买入手数当日不可卖。
// 今日买入 = closed 里今日 BUY 流水 + holding.tFlows 里今日 side='buy' 做T买腿。
// 返回 { liveQty, boughtToday, sellableToday, buys }。
export function t1StatusOf(holding, closed, code) {
  const lp = livePositionOf(holding, code);
  const liveQty = lp ? lp.qty : 0;
  const t0 = bjDayStartTs();
  let boughtToday = 0;
  const buys = [];
  (closed || []).forEach((c) => {
    if (c.code !== code) return;
    if ((c.type || c.kind) !== 'BUY') return;
    const at = c.at || c.buyAt || 0;
    if (at < t0) return;
    boughtToday += (c.qty || 0);
    buys.push({ price: c.price, qty: c.qty, kind: '建仓/加仓' });
  });
  (holding || []).filter((h) => h.code === code).forEach((h) => {
    (h.tFlows || []).forEach((f) => {
      if (f.side === 'buy' && (f.at || 0) >= t0) {
        boughtToday += (f.qty || 0);
        buys.push({ price: f.price, qty: f.qty, kind: '做T买腿' });
      }
    });
  });
  boughtToday = +boughtToday.toFixed(3);
  const sellableToday = Math.max(0, +(liveQty - boughtToday).toFixed(3));
  return { liveQty, boughtToday, sellableToday, buys };
}

// 构造【持仓个股】hold_advice 的 payload(与前端 buildHoldSpec 的 aiPayload 同口径)
export function buildHoldPayload(holding, code, name, portfolio, account, closed, nextTradeDay) {
  const lp = livePositionOf(holding, code);
  let holdCost, holdQty, openTNet;
  if (lp) {
    holdCost = lp.cost; holdQty = lp.qty; openTNet = lp.hasOpenT ? lp.tNetHands : 0;
  } else {
    const hs = (holding || []).filter((h) => h.code === code);
    let tNet = 0, baseCostSum = 0, baseQtySum = 0;
    for (const h of hs) {
      const rr = computeTFlows(h.tFlows);
      tNet += (rr.openBuy || 0) - (rr.openSell || 0);
      baseCostSum += (h.buyPrice || 0) * (h.qty || 0); baseQtySum += (h.qty || 0);
    }
    holdCost = baseQtySum > 0 ? +(baseCostSum / baseQtySum).toFixed(3) : null;
    holdQty = 0; openTNet = tNet;
  }
  const stockWeight = (() => {
    const p = portfolio && portfolio.positions ? portfolio.positions.find((x) => x.code === code) : null;
    return p && p.weight != null ? p.weight : null;
  })();
  // T+1 买入时间锁定字段(与前端 t1Fields 同口径)
  let t1 = {};
  try {
    const st = t1StatusOf(holding, closed, code);
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
    code, name, holdCost, holdQty, openTNet,
    ...t1,
    account: { ...accountFrom(portfolio, account), stockWeight },
  };
}

// 构造【自选/非持仓个股】buy_advice 的 payload(与前端 buildWatchSpec 的 aiPayload 同口径)
export function buildWatchPayload(code, name, portfolio, account) {
  return { code, name, account: accountFrom(portfolio, account) };
}
