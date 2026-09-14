#!/usr/bin/env python3
"""方案A 第1步：读 5 年主板日线+alpha 快照，输出「精简持有期样本」JSONL。

只做重 IO 与 join（Python 能吃下 227MB 大 JSON，JS 会 ERR_STRING_TOO_LONG）：
  - 每个信号日按「前一交易日」额排序取因果池 topN；
  - 对池中且有 alpha 快照的股票，取入场次日开盘与之后 horizon 日持有期 bar；
  - 输出每行 { signalDate, entryDate, code, fold, entryPrice, holdingRows,
    alpha{percentile,rankIc20,rankIc60,scoreMomentum5} }。
退出结算与特征装配交给 JS(scripts/settle-v4-daily-samples.mjs)，保证净R/alpha
特征口径与 shared/exitActionValue.js、alpha158SignalFeatures.js 完全一致。
"""

import argparse
import gzip
import json
import os
from collections import defaultdict

MAIN_BOARD = ("000", "001", "002", "003", "600", "601", "603", "605")
MIN_AMOUNT = 30_000_000
MIN_TURNOVER = 0.3


def is_main(code):
    c = str(code or "")
    return len(c) == 6 and c[:3] in MAIN_BOARD


def num(v):
    try:
        f = float(v)
        return f if f == f else None  # 排除 NaN
    except (TypeError, ValueError):
        return None


def eligible(row):
    return (
        is_main(row.get("code"))
        and not row.get("isSt")
        and (num(row.get("close")) or 0) > 0
        and (num(row.get("amount")) or 0) >= MIN_AMOUNT
        and (num(row.get("turnover")) or 0) >= MIN_TURNOVER
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--daily", required=True)
    p.add_argument("--alpha-snapshot", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--universe-size", type=int, default=300)
    p.add_argument("--horizon", type=int, default=10)
    args = p.parse_args()

    with gzip.open(args.daily) as f:
        daily = json.load(f)
    with gzip.open(args.alpha_snapshot) as f:
        alpha = json.load(f)

    by_date = defaultdict(list)
    by_code = defaultdict(list)
    for row in daily:
        if not is_main(row.get("code")):
            continue
        by_date[str(row["date"])].append(row)
        by_code[str(row["code"])].append(row)
    for rows in by_code.values():
        rows.sort(key=lambda r: str(r["date"]))
    code_date_pos = {
        code: {str(r["date"]): i for i, r in enumerate(rows)}
        for code, rows in by_code.items()
    }
    alpha_by_key = {
        f'{r["date"]}:{r["code"]}': r for r in alpha["rows"]
    }
    alpha_dates = sorted({r["date"] for r in alpha["rows"]})
    first_alpha = alpha_dates[0] if alpha_dates else "99999999"

    dates = sorted(by_date)
    last_signal = len(dates) - args.horizon - 2
    written = 0
    candidates = 0
    with open(args.output, "w", encoding="utf-8") as out:
        for di, signal_date in enumerate(dates):
            if signal_date < first_alpha or di < 1 or di > last_signal:
                continue
            prev = [r for r in by_date[dates[di - 1]] if eligible(r)]
            prev.sort(key=lambda r: -(num(r.get("amount")) or 0))
            universe = [str(r["code"]) for r in prev[: args.universe_size]]
            entry_date = dates[di + 1]
            for code in universe:
                a = alpha_by_key.get(f"{signal_date}:{code}")
                if not a:
                    continue
                candidates += 1
                pos = code_date_pos.get(code, {}).get(entry_date)
                if pos is None:
                    continue
                series = by_code[code]
                entry = series[pos]
                entry_open = num(entry.get("open"))
                if not entry_open or entry_open <= 0:
                    continue
                holding = []
                for r in series[pos + 1: pos + 1 + args.horizon]:
                    o, h, low, c = (
                        num(r.get("open")), num(r.get("high")),
                        num(r.get("low")), num(r.get("close")),
                    )
                    if None in (o, h, low, c) or min(o, h, low, c) <= 0:
                        continue
                    holding.append({
                        "date": str(r["date"]),
                        "open": o, "high": h, "low": low, "close": c,
                        "preClose": num(r.get("preClose")) or o,
                    })
                if len(holding) < 2:
                    continue
                out.write(json.dumps({
                    "signalDate": signal_date,
                    "entryDate": entry_date,
                    "code": code,
                    "fold": a.get("fold"),
                    "entryPrice": round(entry_open, 4),
                    "holdingRows": holding,
                    "alpha": {
                        "percentile": a.get("percentile"),
                        "rankIc20": a.get("rankIc20"),
                        "rankIc60": a.get("rankIc60"),
                        "scoreMomentum5": a.get("scoreMomentum5"),
                    },
                }, ensure_ascii=False) + "\n")
                written += 1
            if di % 50 == 0:
                print(json.dumps({
                    "stage": "PROGRESS", "signalDate": signal_date,
                    "written": written, "candidates": candidates,
                }), flush=True)
    print(json.dumps({
        "stage": "DONE", "output": os.path.abspath(args.output),
        "written": written, "candidates": candidates,
    }))


if __name__ == "__main__":
    main()
