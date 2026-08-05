"""
Tushare 面板数据层（P1 正交数据源）。
================================================================
产出「每只股票的逐日对齐面板」，供 build_dataset_ts.py 计算 36 个量价因子
+ 一组来自 Tushare 的**正交**因子(估值/换手/资金流)。

为什么 Tushare 是真正的正交增量(而非又一批同源价量)：
  现有 36 因子全部由「单股日线 OHLCV」派生 → 信息同源、彼此相关，已到边际。
  Tushare 带来 OHLCV 结构上无法表达的三类信息：
    1) 估值(pe_ttm/pb/ps_ttm/dv_ttm)      —— 基本面锚，来自财报，与价量正交。
    2) 真实自由流通换手率 turnover_rate_f  —— 需流通股本，OHLCV 拿不到。
    3) 主力资金流(大单/超大单 净额)         —— 逐笔分类订单流,OHLCV 无此维度。
  这些是「换个信息源」的正交增量,最有希望突破 AUC 天花板。

数据口径：
  - daily 返回**不复权** OHLCV；adj_factor 给累计复权因子。
  - 前复权价 = raw * adj_factor / adj_factor[最新]（与线上 Tencent qfq 口径一致，
    保证因子可比）。成交量为原始量(比率类因子对常数缩放不敏感)。
  - daily_basic / moneyflow 按 trade_date 与价格序列对齐(缺失前向填充/置零)。

安全：token 只从 env(TUSHARE_TOKEN) 走 tushare_client，绝不落库。

用法：
  set -a; source ../.env; set +a
  python3 tushare_panel.py --pool 900 --start 20220101 --out panel_cache
"""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

from tushare_client import TushareClient

HERE = os.path.dirname(os.path.abspath(__file__))


def build_pool(ts, total, min_circ_mv=3e6, exclude_star=True):
    """构建流动性股票池：stock_basic 全 A → 排除 ST/次新/(可选)科创板 →
    用最近交易日 daily_basic(by-date bulk) 的流通市值排序取前 total。
    min_circ_mv 单位万元(daily_basic total_mv/circ_mv 单位为万元)。"""
    basics = ts.stock_basic(fields="ts_code,symbol,name,market,list_date")
    # 最近交易日
    cal = ts.rows("trade_cal", {"exchange": "SSE", "is_open": "1",
                                "start_date": "20260101", "end_date": "20260805"},
                  "cal_date")
    last_trade = max(r["cal_date"] for r in cal) if cal else "20260804"
    db = ts.daily_basic(trade_date=last_trade,
                        fields="ts_code,circ_mv,total_mv,turnover_rate_f")
    mv = {r["ts_code"]: (r.get("circ_mv") or 0.0) for r in db}
    cand = []
    for b in basics:
        code = b["ts_code"]
        name = b.get("name", "")
        if not code:
            continue
        if "ST" in (name or "").upper():
            continue
        if exclude_star and code.startswith(("688", "8", "4")):  # 科创板/北交所
            continue
        cmv = mv.get(code, 0.0)
        if cmv < min_circ_mv:
            continue
        cand.append((code, name, cmv))
    cand.sort(key=lambda x: -x[2])
    pool = [(c, n) for c, n, _ in cand[:total]]
    print(f"[pool] basics={len(basics)} last_trade={last_trade} "
          f"filtered={len(cand)} -> pool={len(pool)}")
    return pool


def _to_arrays(rows, key, fields):
    """rows(list[dict]) 按 trade_date 升序，返回 {field: np.array} + dates。"""
    rows = [r for r in rows if r.get(key)]
    rows.sort(key=lambda r: r[key])
    dates = [r[key] for r in rows]
    out = {}
    for fld in fields:
        vals = []
        for r in rows:
            x = r.get(fld)
            vals.append(float(x) if x is not None and x != "" else np.nan)
        out[fld] = np.array(vals, dtype=np.float64)
    return dates, out


def fetch_one(ts, code, start, end):
    """拉单只股票的 qfq OHLCV + daily_basic + moneyflow，按日期对齐。
    返回 dict 或 None(数据不足)。"""
    dl = ts.daily(code, start_date=start, end_date=end,
                  fields="trade_date,open,high,low,close,vol,amount")
    if len(dl) < 120:
        return None
    dates, d = _to_arrays(dl, "trade_date", ["open", "high", "low", "close", "vol", "amount"])
    n = len(dates)

    # 复权因子对齐
    af = ts.adj_factor(code, start_date=start, end_date=end)
    af_map = {r["trade_date"]: (r.get("adj_factor") or 1.0) for r in af}
    adj = np.array([float(af_map.get(dt, np.nan)) for dt in dates], dtype=np.float64)
    # 前向/后向填充复权因子缺口
    adj = _ffill(adj)
    if not np.isfinite(adj).any():
        adj = np.ones(n)
    latest = adj[np.isfinite(adj)][-1]
    qadj = np.where(np.isfinite(adj), adj / latest, 1.0)  # 前复权系数

    o = d["open"] * qadj
    h = d["high"] * qadj
    l = d["low"] * qadj
    c = d["close"] * qadj
    v = d["vol"]                       # 原始量(比率类因子不受常数缩放影响)
    amount = d["amount"]              # 千元(daily.amount 单位为千元)

    # daily_basic 对齐
    db = ts.daily_basic(ts_code=code, start_date=start, end_date=end,
                        fields="trade_date,turnover_rate_f,volume_ratio,pe_ttm,pb,"
                        "ps_ttm,dv_ttm,total_mv,circ_mv")
    _, dbm = _align_by_dates(db, "trade_date", dates,
                             ["turnover_rate_f", "volume_ratio", "pe_ttm", "pb",
                              "ps_ttm", "dv_ttm", "total_mv", "circ_mv"])

    # moneyflow 对齐
    mf = ts.moneyflow(ts_code=code, start_date=start, end_date=end,
                      fields="trade_date,buy_lg_amount,sell_lg_amount,"
                      "buy_elg_amount,sell_elg_amount,net_mf_amount")
    _, mfm = _align_by_dates(mf, "trade_date", dates,
                             ["buy_lg_amount", "sell_lg_amount", "buy_elg_amount",
                              "sell_elg_amount", "net_mf_amount"])

    return {
        "code": code, "dates": dates,
        "o": o, "h": h, "l": l, "c": c, "v": v, "amount": amount,
        "basic": dbm, "mf": mfm,
    }


def _ffill(a):
    a = a.copy()
    last = np.nan
    for i in range(len(a)):
        if np.isfinite(a[i]):
            last = a[i]
        elif np.isfinite(last):
            a[i] = last
    # 头部回填
    if len(a) and not np.isfinite(a[0]):
        valid = a[np.isfinite(a)]
        if len(valid):
            a[np.where(~np.isfinite(a))] = valid[0]
    return a


def _align_by_dates(rows, key, target_dates, fields):
    """把 rows 按 target_dates 对齐(缺失前向填充);返回 dates + {field: array(对齐后)}。"""
    m = {}
    for r in rows:
        dt = r.get(key)
        if dt:
            m[dt] = r
    out = {}
    for fld in fields:
        arr = np.array([
            (float(m[dt][fld]) if (dt in m and m[dt].get(fld) not in (None, ""))
             else np.nan)
            for dt in target_dates], dtype=np.float64)
        out[fld] = _ffill(arr)
    return target_dates, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", type=int, default=900)
    ap.add_argument("--start", default="20220101")
    ap.add_argument("--end", default="20260805")
    ap.add_argument("--out", default="panel_cache")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--min-circ-mv", type=float, default=3e6)
    a = ap.parse_args()

    ts = TushareClient(max_per_min=135)
    os.makedirs(os.path.join(HERE, a.out), exist_ok=True)
    t0 = time.time()
    pool = build_pool(ts, a.pool, min_circ_mv=a.min_circ_mv)
    json.dump([[c, n] for c, n in pool],
              open(os.path.join(HERE, a.out, "_pool.json"), "w"), ensure_ascii=False)

    ok = fail = 0
    done = 0

    def _job(item):
        code, name = item
        fp = os.path.join(HERE, a.out, code.replace(".", "_") + ".npz")
        if os.path.exists(fp):
            return code, "cached"
        try:
            p = fetch_one(ts, code, a.start, a.end)
            if p is None:
                return code, "insufficient"
            np.savez_compressed(
                fp, dates=np.array(p["dates"]),
                o=p["o"].astype(np.float32), h=p["h"].astype(np.float32),
                l=p["l"].astype(np.float32), c=p["c"].astype(np.float32),
                v=p["v"].astype(np.float32), amount=p["amount"].astype(np.float32),
                **{f"b_{k}": vv.astype(np.float32) for k, vv in p["basic"].items()},
                **{f"m_{k}": vv.astype(np.float32) for k, vv in p["mf"].items()})
            return code, "ok"
        except Exception as e:  # noqa: BLE001
            return code, f"err:{str(e)[:80]}"

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = [ex.submit(_job, it) for it in pool]
        for fu in as_completed(futs):
            code, st = fu.result()
            done += 1
            if st in ("ok", "cached"):
                ok += 1
            else:
                fail += 1
            if done % 50 == 0:
                print(f"  {done}/{len(pool)} ok={ok} fail={fail} "
                      f"elapsed={time.time()-t0:.0f}s (last {code}:{st})", flush=True)

    print(f"[done] pool={len(pool)} ok={ok} fail={fail} in {time.time()-t0:.0f}s "
          f"-> {a.out}/", flush=True)


if __name__ == "__main__":
    main()
