"""
「事件确认高把握」层 —— 离线每日标记生成器(P2 结论落地)。
============================================================
背景(P2 已成结论,spike_event_tier.py):
  事件不是"更好的连续特征"(E1 ΔAUC=+0.0011<0.005 已拒绝、且事件无法进线上 /predict 的 OHLCV 向量),
  而是"正交的高精度筛子":命中高纯度事件规则的票,样本外精确率 89%~98%,且能覆盖到信号头(OHLCV)
  完全漏掉的 495 个 88.7% 精度买点。因此它的正确落地形态 = 离线批处理阶段逐票追加"事件确认"标记,
  与信号头结果【并列】给军师/前端;线上打分向量维持 36 维不变(零线上风险)。

本脚本(每日流水线一步):
  1) 用 TushareClient 拉【最新交易日】(或 --date 指定日) 的:
       limit_list_d  涨停/连板/炸板/封单额
       top_list      龙虎榜净买额
  2) 顺带并入 events_cache.json(与训练/回测同一缓存,便于下次重训直接复用,不构成未来函数:
     涨停/龙虎榜均在 T 日收盘后可知)。
  3) 按 P2 验证的【高纯度确认规则】逐票判定:
       evt_hit = (连板>=2)  OR  (涨停 AND 封单额 > 当日涨停封单额中位数)  OR  (龙虎榜 AND 净买>0)
  4) 产出 event_tags.json —— {code6: {confirmed, reasons[], streak, fdStrong, lhbNetYi, precisionRef, tradeDate}}
     以 6 位纯代码为键(与前端 payload.code 对齐,serving 侧免归一化)。
  5) 上传 OSS(前缀 quantmodel/),量化服务 TTL 到期后热加载,/predict 按 code 查表回传 eventTag。

精度参考(来自 spike_event_tier_result.json,holdout 样本外):
  连板>=2 93.9% · 连板>=3 97.6% · 涨停&封单强 92.3% · 龙虎榜净买 89.0% · 组合命中 91.1%

用法:
  set -a; . ./.env; set +a
  python3 build_event_tags.py                # 自动取最新交易日
  python3 build_event_tags.py --date 20260729 --no-upload
"""
import argparse
import json
import os

import numpy as np

from tushare_client import TushareClient

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "events_cache.json")
OUT = os.path.join(HERE, "event_tags.json")

LU_FIELDS = "ts_code,trade_date,name,pct_chg,limit_amount,fd_amount,open_times,limit_times,limit"
LHB_FIELDS = "ts_code,trade_date,net_amount,l_buy,l_sell,reason"

# holdout 样本外精度参考(spike_event_tier.py 结论),供军师/前端展示"这类事件历史多准"
PREC_REF = {
    "streak2": 93.9, "streak3": 97.6, "limitFdStrong": 92.3, "lhbNetBuy": 89.0,
}


def code6(ts_code):
    """'600519.SH' -> '600519';与前端 payload.code 对齐。"""
    return str(ts_code).split(".")[0]


def latest_trade_date(ts):
    """用 index_daily(沪深300)最近一根确定最新交易日 YYYYMMDD。"""
    rows = ts.index_daily(ts_code="000300.SH")
    tds = sorted({str(r.get("trade_date")) for r in rows if r.get("trade_date")})
    if not tds:
        raise RuntimeError("无法确定最新交易日(index_daily 空)")
    return tds[-1]


def fetch_day(ts, td):
    """拉单日涨停名单 + 龙虎榜,返回 {'lu':{code:{...}}, 'lhb':{code:{...}}}(与 fetch_events 同结构)。"""
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
            prev = rec["lhb"].get(code, {"net": 0.0, "lbuy": 0.0, "lsell": 0.0})
            prev["net"] += float(r.get("net_amount") or 0.0)
            prev["lbuy"] += float(r.get("l_buy") or 0.0)
            prev["lsell"] += float(r.get("l_sell") or 0.0)
            rec["lhb"][code] = prev
    except Exception as e:
        print(f"  [warn] top_list {td}: {e}")
    return rec


def build_tags(rec, td):
    """按 P2 高纯度规则逐票产出确认标记。返回 {code6: tag}。
    规则: (连板>=2) OR (涨停 & 封单额>当日涨停封单额中位数) OR (龙虎榜 & 净买>0)。"""
    lu = rec.get("lu", {})
    lhb = rec.get("lhb", {})
    # 当日涨停封单额中位数(用于"封单强度"判定,与 spike_event.build_event_cols 口径一致)
    fds = [float(v.get("fd") or 0.0) for v in lu.values()
           if v.get("limit") == "U" and v.get("fd")]
    fd_med = float(np.median(fds)) if fds else 0.0

    tags = {}
    codes = set(lu.keys()) | set(lhb.keys())
    for ts_code in codes:
        reasons, precs = [], []
        streak = 0
        fd_strong = False
        lhb_net_yi = None

        u = lu.get(ts_code)
        if u and u.get("limit") == "U":
            streak = int(u.get("limit_times") or 0)
            fd = float(u.get("fd") or 0.0)
            fd_strong = bool(fd_med > 0 and fd > fd_med)
            if streak >= 3:
                reasons.append(f"连板{streak}板"); precs.append(PREC_REF["streak3"])
            elif streak >= 2:
                reasons.append(f"连板{streak}板"); precs.append(PREC_REF["streak2"])
            elif fd_strong:
                reasons.append("涨停·封单强(高于当日涨停封单中位数)"); precs.append(PREC_REF["limitFdStrong"])

        h = lhb.get(ts_code)
        if h:
            net = float(h.get("net", 0.0))
            lhb_net_yi = round(net / 1e8, 2)
            if net > 0:
                reasons.append(f"龙虎榜净买+{lhb_net_yi}亿"); precs.append(PREC_REF["lhbNetBuy"])

        if not reasons:
            continue  # 未命中高纯度规则的票不追加标记(只标"确认",不标"否决")
        tags[code6(ts_code)] = {
            "confirmed": True,
            "reasons": reasons,
            "streak": streak,
            "fdStrong": fd_strong,
            "lhbNetYi": lhb_net_yi,
            "precisionRef": round(float(max(precs)), 1),  # 取最强证据的历史精度
            "tradeDate": td,
        }
    return tags, fd_med


def upload_oss(path, key):
    try:
        import oss2
    except Exception:
        print("[oss] oss2 未安装,跳过上传"); return False
    ak = os.environ.get("OSS_ACCESS_KEY_ID"); sk = os.environ.get("OSS_ACCESS_KEY_SECRET")
    bkt = os.environ.get("OSS_BUCKET")
    if not (ak and sk and bkt):
        print("[oss] 缺 OSS_* 凭证,跳过上传"); return False
    endpoint = os.environ.get("OSS_ENDPOINT")
    if not endpoint:
        region = os.environ.get("OSS_REGION", "oss-cn-hangzhou")
        if not region.startswith("oss-"):
            region = "oss-" + region
        endpoint = f"https://{region}.aliyuncs.com"
    b = oss2.Bucket(oss2.Auth(ak, sk), endpoint, bkt)
    b.put_object_from_file(key, path)
    got = b.head_object(key)
    print(f"[oss] uploaded {os.path.basename(path)} -> oss://{bkt}/{key} ({got.content_length}B)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="交易日 YYYYMMDD;默认自动取最新交易日")
    ap.add_argument("--prefix", default=os.environ.get("QUANT_MODEL_PREFIX", "quantmodel/"))
    ap.add_argument("--no-upload", action="store_true", help="只本地产出,不上传 OSS")
    a = ap.parse_args()

    ts = TushareClient()
    td = a.date or latest_trade_date(ts)
    print(f"[event-tags] trade_date={td}")

    rec = fetch_day(ts, td)
    print(f"[event-tags] fetched lu={len(rec['lu'])} lhb={len(rec['lhb'])}")

    # 并入 events_cache.json(便于重训复用;已存在则覆盖当日)
    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE))
        except Exception:
            cache = {}
    cache[td] = rec
    json.dump(cache, open(CACHE, "w"))
    print(f"[event-tags] cache merged, total {len(cache)} days")

    tags, fd_med = build_tags(rec, td)
    n_streak = sum(1 for t in tags.values() if t["streak"] >= 2)
    n_fd = sum(1 for t in tags.values() if t["fdStrong"] and t["streak"] < 2)
    n_lhb = sum(1 for t in tags.values() if t["lhbNetYi"] and t["lhbNetYi"] > 0)
    out = {
        "tradeDate": td,
        "rule": "连板>=2 OR (涨停&封单>当日涨停封单中位数) OR (龙虎榜&净买>0)",
        "fdMedian": round(fd_med, 2),
        "precisionRef": PREC_REF,
        "count": len(tags),
        "tags": tags,
    }
    json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=2)
    print(f"[event-tags] confirmed={len(tags)} (连板>=2:{n_streak} 封单强:{n_fd} 龙虎榜净买:{n_lhb}) "
          f"-> {os.path.basename(OUT)}")

    if not a.no_upload:
        upload_oss(OUT, a.prefix + "event_tags.json")


if __name__ == "__main__":
    main()
