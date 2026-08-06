"""
Spike B 数据准备：拉取样本日期范围内每个交易日的
  - 涨停/跌停名单 limit_list_d（含连板 limit_times / 炸板 open_times / 封单 fd_amount）
  - 龙虎榜 top_list（净买额 net_amount / 上榜原因）
按交易日缓存到 events_cache.json。只依赖当日盘后披露信息，喂给 T 日样本行(标签是 T 之后的前向收益)
不构成未来函数：涨停/龙虎榜均在 T 日收盘后可知，T+1 开盘前可用。
"""
import os, json, time
import numpy as np
from tushare_client import TushareClient

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "events_cache.json")

LU_FIELDS = "ts_code,trade_date,name,pct_chg,limit_amount,fd_amount,open_times,limit_times,limit"
LHB_FIELDS = "ts_code,trade_date,net_amount,l_buy,l_sell,reason"


def main():
    d = np.load(os.path.join(HERE, "dataset_ts_base.npz"), allow_pickle=True)
    dates = sorted(set(d["dates"].astype(str)))
    print(f"[events] {len(dates)} trading days {dates[0]}~{dates[-1]}")

    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE))
            print(f"[events] resume {len(cache)} days cached")
        except Exception:
            cache = {}

    ts = TushareClient()
    todo = [x for x in dates if x not in cache]
    print(f"[events] to fetch {len(todo)} days")
    for k, td in enumerate(todo):
        rec = {"lu": {}, "lhb": {}}
        try:
            for r in ts.rows("limit_list_d", {"trade_date": td}, LU_FIELDS):
                code = r.get("ts_code")
                if not code:
                    continue
                rec["lu"][code] = {
                    "limit": r.get("limit"),
                    "limit_times": r.get("limit_times") or 0,
                    "open_times": r.get("open_times") or 0,
                    "fd": r.get("fd_amount") or 0.0,
                    "la": r.get("limit_amount") or 0.0,
                }
        except Exception as e:
            print(f"  [warn] limit_list_d {td}: {e}")
        try:
            for r in ts.rows("top_list", {"trade_date": td}, LHB_FIELDS):
                code = r.get("ts_code")
                if not code:
                    continue
                # 同一票可能多行(多个上榜原因)——净额累加
                prev = rec["lhb"].get(code, {"net": 0.0, "lbuy": 0.0, "lsell": 0.0})
                prev["net"] += float(r.get("net_amount") or 0.0)
                prev["lbuy"] += float(r.get("l_buy") or 0.0)
                prev["lsell"] += float(r.get("l_sell") or 0.0)
                rec["lhb"][code] = prev
        except Exception as e:
            print(f"  [warn] top_list {td}: {e}")
        cache[td] = rec
        if (k + 1) % 25 == 0:
            json.dump(cache, open(CACHE, "w"))
            print(f"  [{k+1}/{len(todo)}] {td} lu={len(rec['lu'])} lhb={len(rec['lhb'])}")
    json.dump(cache, open(CACHE, "w"))
    print(f"[events] done, {len(cache)} days -> {CACHE}")


if __name__ == "__main__":
    main()
