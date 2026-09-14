#!/usr/bin/env python3
"""Task12 辅助：为 v4 样本补「入场前 trailing 收益序列」，供组合层相关性去重。

严格无前视：只取 signalDate 当日及之前的最近 window 个交易日收盘价，算日收益率
序列（长度 window-1）。绝不使用持有期未来 bar。输出精简 JSONL：
  { signalDate, code, fold, alphaScorePctRank, netRHold, trailingReturns }
netR 由 settle 阶段已算好（HOLD_TO_HORIZON），此处从已结算样本 join 回来，避免重算。
"""

import argparse
import gzip
import json
import os
from collections import defaultdict

MAIN_BOARD = ("000", "001", "002", "003", "600", "601", "603", "605")


def is_main(code):
    c = str(code or "")
    return len(c) == 6 and c[:3] in MAIN_BOARD


def num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--daily", required=True)
    p.add_argument("--settled", required=True, help="settle 输出的 v4 样本 JSONL")
    p.add_argument("--output", required=True)
    p.add_argument("--window", type=int, default=20)
    args = p.parse_args()

    with gzip.open(args.daily) as f:
        daily = json.load(f)
    by_code = defaultdict(list)
    for row in daily:
        if is_main(row.get("code")):
            by_code[str(row["code"])].append(row)
    for rows in by_code.values():
        rows.sort(key=lambda r: str(r["date"]))
    code_date_pos = {
        code: {str(r["date"]): i for i, r in enumerate(rows)}
        for code, rows in by_code.items()
    }

    written = 0
    missing = 0
    with open(args.settled, encoding="utf-8") as src, \
            open(args.output, "w", encoding="utf-8") as out:
        for line in src:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            code = str(row["code"])
            signal_date = str(row["signalDate"])
            pos = code_date_pos.get(code, {}).get(signal_date)
            series = by_code.get(code, [])
            if pos is None or pos < 2:
                missing += 1
                continue
            # 取 signalDate 及之前 window 个 bar 的收盘价 → 收益率序列。
            start = max(0, pos - args.window + 1)
            closes = [num(r.get("close")) for r in series[start:pos + 1]]
            closes = [c for c in closes if c and c > 0]
            if len(closes) < 4:
                missing += 1
                continue
            trailing = [
                round(closes[i] / closes[i - 1] - 1.0, 6)
                for i in range(1, len(closes))
            ]
            out.write(json.dumps({
                "signalDate": signal_date,
                "code": code,
                "fold": row.get("fold"),
                "alphaScorePctRank": (
                    row.get("alphaFeatures", {}).get("alphaScorePctRank")
                ),
                "hardStopHit": row.get("hardStopHit"),
                "netRHold": row.get("netR", {}).get("HOLD_TO_HORIZON"),
                "trailingReturns": trailing,
            }, ensure_ascii=False) + "\n")
            written += 1
    print(json.dumps({
        "stage": "DONE", "output": os.path.abspath(args.output),
        "written": written, "missing": missing,
    }))


if __name__ == "__main__":
    main()
