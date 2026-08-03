"""
数据管道：批量拉日线 → 计算因子 → ATR锚定的未来5日达标标签 → 训练集 parquet/npz
数据源（沙箱可用）：
  - 股票池：Sina Market_Center（hs300 + 创业板成交额前N）
  - 日线  ：Tencent web.ifzq.gtimg.cn 前复权(qfq)，格式 [date,open,close,high,low,volume]
用法：
  python3 build_dataset.py --pool 600 --bars 700 --out dataset.npz
输出：dataset.npz  含 X(样本×特征) y(0/1) meta(codes/dates/feat_names)
"""
import argparse
import json
import os
import time
import urllib.request
import numpy as np

from factors_lib import compute_factors, feature_vector, target_price, FEATURE_NAMES

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://finance.sina.com.cn/",
    "Accept": "*/*",
}
SINA = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
TX_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"


def _get(url, timeout=20, retries=3, backoff=2.0):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(backoff * (i + 1))
    raise last


def fetch_pool(node, want, sort="amount"):
    """从 Sina 分页取某板块成分股（按成交额降序，取流动性好的）。返回 [(symbol,name)]"""
    out, page, num = [], 1, 80
    while len(out) < want and page <= 60:
        url = f"{SINA}?page={page}&num={num}&sort={sort}&asc=0&node={node}"
        try:
            data = json.loads(_get(url).decode("utf-8", "ignore") or "[]")
        except Exception:
            break
        if not data:
            break
        for x in data:
            sym = x.get("symbol", "")
            if sym.startswith(("sh", "sz")):
                out.append((sym, x.get("name", "")))
        page += 1
    return out[:want]


def build_pool(total, cache="pool_cache.json"):
    """hs300 全量 + 创业板成交额前列，去重。带本地缓存，避免 Sina 抖动。"""
    if os.path.exists(cache):
        try:
            saved = json.load(open(cache))
            if len(saved) >= total:
                print(f"[pool] loaded {len(saved)} from cache {cache}")
                return [tuple(x) for x in saved][:total]
        except Exception:
            pass
    hs = fetch_pool("hs300", 300, sort="amount")
    rest = max(0, total - len(hs))
    cyb = fetch_pool("cyb", rest, sort="amount") if rest else []
    seen, pool = set(), []
    for sym, name in hs + cyb:
        if sym not in seen:
            seen.add(sym); pool.append((sym, name))
    pool = pool[:total]
    if len(pool) >= min(50, total):
        json.dump(pool, open(cache, "w"), ensure_ascii=False)
    return pool


def fetch_kline(symbol, bars=700):
    """Tencent 前复权日线，返回 (closes,highs,lows,vols,dates) 或 None"""
    url = f"{TX_KLINE}?param={symbol},day,,,{bars},qfq"
    try:
        j = json.loads(_get(url).decode("utf-8", "ignore"))
        node = j["data"][symbol]
        rows = node.get("qfqday") or node.get("day") or []
    except Exception:
        return None
    if len(rows) < 90:
        return None
    dates = [r[0] for r in rows]
    o = np.array([float(r[1]) for r in rows])   # noqa: F841 (open unused)
    c = np.array([float(r[2]) for r in rows])
    h = np.array([float(r[3]) for r in rows])
    l = np.array([float(r[4]) for r in rows])
    v = np.array([float(r[5]) for r in rows])
    return c, h, l, v, dates


def make_samples(c, h, l, v, dates, horizon=5, min_hist=60, stride=2):
    """滑窗生成样本：在每个 t 用截至 t 的历史算因子，
    标签= 未来 horizon 日内最高价是否触及 close_t*(1+target)。"""
    X, y, ds = [], [], []
    n = len(c)
    for t in range(min_hist, n - horizon):
        cc, hh, ll, vv = c[:t + 1], h[:t + 1], l[:t + 1], v[:t + 1]
        f = compute_factors(cc, hh, ll, vv)
        last = f["_last"]
        tgt = target_price(last, f["_atr"])
        fut_high = float(np.max(h[t + 1:t + 1 + horizon]))
        label = 1 if fut_high >= last * (1 + tgt) else 0
        if not np.isfinite(feature_vector(f)).all():
            continue
        X.append(feature_vector(f)); y.append(label); ds.append(dates[t])
    # 下采样步长，减少相邻高相关样本
    if stride > 1:
        X, y, ds = X[::stride], y[::stride], ds[::stride]
    return X, y, ds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", type=int, default=600)
    ap.add_argument("--bars", type=int, default=700)
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--out", default="dataset.npz")
    a = ap.parse_args()

    t0 = time.time()
    pool = build_pool(a.pool)
    print(f"[pool] {len(pool)} stocks in {time.time()-t0:.1f}s")

    X, y, codes, dates = [], [], [], []
    ok = fail = 0
    for i, (sym, name) in enumerate(pool):
        kl = fetch_kline(sym, a.bars)
        if not kl:
            fail += 1
            continue
        c, h, l, v, dts = kl
        xs, ys, dss = make_samples(c, h, l, v, dts, horizon=a.horizon)
        X.extend(xs); y.extend(ys); dates.extend(dss); codes.extend([sym] * len(xs))
        ok += 1
        if (i + 1) % 50 == 0:
            pos = np.mean(y) if y else 0
            print(f"  {i+1}/{len(pool)} ok={ok} fail={fail} samples={len(X)} pos_rate={pos:.3f} "
                  f"elapsed={time.time()-t0:.0f}s")

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.int8)
    if len(X) == 0:
        print(f"[ERROR] no samples produced (ok={ok} fail={fail}). Check network/pool.")
        return
    print(f"[done] stocks ok={ok} fail={fail} | samples={len(X)} "
          f"pos_rate={y.mean():.3f} feats={X.shape[1]} in {time.time()-t0:.0f}s")
    np.savez_compressed(a.out, X=X, y=y, codes=np.array(codes),
                        dates=np.array(dates), feat_names=np.array(FEATURE_NAMES))
    print(f"[saved] {a.out}")


if __name__ == "__main__":
    main()
