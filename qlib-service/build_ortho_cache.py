"""
P1 正交因子对齐器 —— 给现有 dataset.npz 的每个样本(code,date)补齐 Tushare 正交因子。
================================================================
为什么这样做（科学纪律）：
  上一轮 v3 因子扩展曾因损害 holdout AUC 被拒。P1 要证明「Tushare 正交数据」有效，
  必须用**完全相同的样本/标签/基础36因子**做对照，只增加正交列 → 干净的 A/B。
  故不重建样本，而是复用 dataset.npz 的 (codes, dates) 行序，逐行贴正交向量。

流程：
  1) 读 dataset.npz → 拿到 codes/dates（行序固定）与唯一股票集。
  2) 逐股票拉 daily_basic + moneyflow 全区间一次（带本地缓存，限速 135/min）。
  3) 对每个样本行，按 (code, date) 查当日 daily_basic + 截至当日最近5日 moneyflow →
     ortho_vector()。查不到则整行正交因子安全归零（覆盖率会打印出来）。
  4) 存 ortho.npz: Xo(n×len(ORTHO_NAMES)), names, coverage。

用法：
  set -a; . ../.env; set +a
  python3 build_ortho_cache.py --data dataset.npz --out ortho.npz
"""
import argparse
import json
import os
import time
import numpy as np

from tushare_client import TushareClient
from ortho_factors import ortho_vector, tx_to_ts_code, ORTHO_NAMES

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_CACHE = os.path.join(HERE, "ortho_raw_cache.json")


def ymd(d):
    """'2022-08-15' -> '20220815'。"""
    return str(d).replace("-", "")


def fetch_stock_raw(ts, sym, start, end):
    """拉单股 daily_basic + moneyflow 全区间，返回 (basic_by_date, mf_sorted)。
    basic_by_date: {trade_date(YYYYMMDD): row}
    mf_sorted: list[(trade_date, row)] 升序。"""
    code = tx_to_ts_code(sym)
    basic = {}
    try:
        for r in ts.daily_basic(ts_code=code, start_date=start, end_date=end):
            td = str(r.get("trade_date"))
            if td:
                basic[td] = r
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] daily_basic {code}: {e}")
    mf = []
    try:
        for r in ts.moneyflow(ts_code=code, start_date=start, end_date=end):
            td = str(r.get("trade_date"))
            if td:
                mf.append((td, r))
    except Exception as e:  # noqa: BLE001
        print(f"  [warn] moneyflow {code}: {e}")
    mf.sort(key=lambda x: x[0])
    return basic, mf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "dataset.npz"))
    ap.add_argument("--out", default=os.path.join(HERE, "ortho.npz"))
    ap.add_argument("--limit-codes", type=int, default=0,
                    help="仅取前N只股票做快速试验(0=全部)")
    a = ap.parse_args()

    d = np.load(a.data, allow_pickle=True)
    codes = d["codes"].astype(str)
    dates = d["dates"].astype(str)   # 'YYYY-MM-DD'
    n = len(codes)
    uniq = sorted(set(codes))
    if a.limit_codes:
        keep = set(uniq[:a.limit_codes])
        print(f"[subset] 仅用前 {a.limit_codes} 只股票做快速试验")
    else:
        keep = set(uniq)
    all_dates_ymd = sorted({ymd(x) for x in dates})
    start, end = all_dates_ymd[0], all_dates_ymd[-1]
    print(f"[data] rows={n} uniq_codes={len(uniq)} date {start}~{end}")

    ts = TushareClient()

    # ---- 逐股票拉原始数据(带缓存) ----
    cache = {}
    if os.path.exists(RAW_CACHE):
        try:
            cache = json.load(open(RAW_CACHE))
            print(f"[cache] loaded {len(cache)} codes from {os.path.basename(RAW_CACHE)}")
        except Exception:
            cache = {}

    t0 = time.time()
    todo = [c for c in uniq if c in keep and c not in cache]
    print(f"[fetch] need {len(todo)} codes (cached {len(cache)})")
    for i, sym in enumerate(todo):
        basic, mf = fetch_stock_raw(ts, sym, start, end)
        cache[sym] = {"basic": basic, "mf": mf}
        if (i + 1) % 20 == 0:
            # 增量落盘，中断可续
            json.dump(cache, open(RAW_CACHE, "w"))
            print(f"  {i+1}/{len(todo)} fetched, elapsed={time.time()-t0:.0f}s")
    json.dump(cache, open(RAW_CACHE, "w"))
    print(f"[fetch] done in {time.time()-t0:.0f}s")

    # ---- 逐样本行贴正交向量 ----
    m = len(ORTHO_NAMES)
    Xo = np.zeros((n, m), dtype=np.float32)
    hit = 0
    for r in range(n):
        sym = codes[r]
        if sym not in cache:
            continue
        td = ymd(dates[r])
        c = cache[sym]
        basic_row = c["basic"].get(td)
        # moneyflow: 取截至当日(含)最近 5 行
        mf_list = c["mf"]  # list of [td, row]
        recent = [row for (d2, row) in mf_list if d2 <= td][-5:]
        if basic_row is None and not recent:
            continue
        Xo[r] = ortho_vector(basic_row, recent)
        hit += 1
    cov = hit / n if n else 0.0
    print(f"[ortho] coverage={cov*100:.1f}%  (rows with any ortho data: {hit}/{n})")

    np.savez_compressed(a.out, Xo=Xo, names=np.array(ORTHO_NAMES),
                        coverage=np.array([cov]))
    print(f"[saved] {a.out}  shape={Xo.shape}")


if __name__ == "__main__":
    main()
