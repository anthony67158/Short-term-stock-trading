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
import sys
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
    """Tencent 前复权日线，返回 (opens,closes,highs,lows,vols,dates) 或 None"""
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
    o = np.array([float(r[1]) for r in rows])
    c = np.array([float(r[2]) for r in rows])
    h = np.array([float(r[3]) for r in rows])
    l = np.array([float(r[4]) for r in rows])
    v = np.array([float(r[5]) for r in rows])
    return o, c, h, l, v, dates


def fetch_index(symbol="sh000300", bars=900):
    """拉大盘指数日线（默认沪深300），返回 {date: close} 映射，供个股按日期对齐。
    失败返回 {}（则相对因子安全归零，不影响训练）。"""
    url = f"{TX_KLINE}?param={symbol},day,,,{bars},qfq"
    try:
        j = json.loads(_get(url).decode("utf-8", "ignore"))
        node = j["data"][symbol]
        rows = node.get("qfqday") or node.get("day") or []
    except Exception:
        return {}
    return {r[0]: float(r[2]) for r in rows}


def make_samples(o, c, h, l, v, dates, idx_map=None, horizon=5, min_hist=60, stride=1):
    """滑窗生成样本：在每个 t 用截至 t 的历史算因子，
    标签= 未来 horizon 日内最高价是否触及 close_t*(1+target)。
    idx_map: {date: index_close}，若提供则把与个股同日期对齐的大盘序列传入因子计算。"""
    X, y, ds = [], [], []
    n = len(c)
    # 预先构造与个股逐日对齐的大盘收盘序列（缺失日用前值前向填充，再不行用个股当日占位不参与相对计算）
    idx_series = None
    if idx_map:
        idx_series = np.empty(n, dtype=float)
        last_v = np.nan
        for i, dt in enumerate(dates):
            if dt in idx_map:
                last_v = idx_map[dt]
            idx_series[i] = last_v
        # 头部仍是 nan 的用第一个有效值回填
        if np.isnan(idx_series).any():
            valid = idx_series[np.isfinite(idx_series)]
            fill = valid[0] if len(valid) else 1.0
            idx_series = np.where(np.isfinite(idx_series), idx_series, fill)
    for t in range(min_hist, n - horizon):
        oo, cc, hh, ll, vv = o[:t + 1], c[:t + 1], h[:t + 1], l[:t + 1], v[:t + 1]
        ic = idx_series[:t + 1] if idx_series is not None else None
        f = compute_factors(cc, hh, ll, vv, opens=oo, index_closes=ic)
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
    ap.add_argument("--bars", type=int, default=900)
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--index", default="sh000300", help="大盘指数代码（相对因子基准），空串则不用")
    ap.add_argument("--out", default="dataset.npz")
    a = ap.parse_args()

    t0 = time.time()
    pool = build_pool(a.pool)
    print(f"[pool] {len(pool)} stocks in {time.time()-t0:.1f}s")

    # 拉大盘指数，供相对/市场状态因子（失败则空 → 相对因子安全归零）
    idx_map = fetch_index(a.index, a.bars) if a.index else {}
    print(f"[index] {a.index or 'none'} points={len(idx_map)}")

    X, y, codes, dates = [], [], [], []
    ok = fail = 0
    for i, (sym, name) in enumerate(pool):
        kl = fetch_kline(sym, a.bars)
        if not kl:
            fail += 1
            continue
        o, c, h, l, v, dts = kl
        xs, ys, dss = make_samples(o, c, h, l, v, dts, idx_map=idx_map,
                                   horizon=a.horizon, stride=a.stride)
        X.extend(xs); y.extend(ys); dates.extend(dss); codes.extend([sym] * len(xs))
        ok += 1
        if (i + 1) % 50 == 0:
            pos = np.mean(y) if y else 0
            print(f"  {i+1}/{len(pool)} ok={ok} fail={fail} samples={len(X)} pos_rate={pos:.3f} "
                  f"elapsed={time.time()-t0:.0f}s")

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.int8)
    if len(X) == 0:
        # 拉不到任何日线(典型:GitHub 海外 runner 访问新浪/腾讯 CN 行情接口被限流/不可达)。
        # 明确 exit(2) 让上游 subprocess 判失败并区分「数据源不可用」——绝不静默写出空/旧数据集。
        print(f"[ERROR] no samples produced (ok={ok} fail={fail}). "
              f"数据源不可达或被限流(常见于海外 CI 出口 IP)。检查 Sina/Tencent 行情接口连通性。",
              file=sys.stderr)
        sys.exit(2)
    print(f"[done] stocks ok={ok} fail={fail} | samples={len(X)} "
          f"pos_rate={y.mean():.3f} feats={X.shape[1]} in {time.time()-t0:.0f}s")
    np.savez_compressed(a.out, X=X, y=y, codes=np.array(codes),
                        dates=np.array(dates), feat_names=np.array(FEATURE_NAMES))
    print(f"[saved] {a.out}")


if __name__ == "__main__":
    main()
