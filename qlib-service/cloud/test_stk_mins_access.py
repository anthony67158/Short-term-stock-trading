"""Read-only probe for Tushare stk_mins access; never logs credentials."""

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tushare_client import TushareClient


CODE = "600519.SH"
START = "2026-07-29 09:00:00"
END = "2026-07-29 15:30:00"
FIELDS = "ts_code,trade_time,open,close,high,low,vol,amount"
REQUIRED_FIELDS = set(FIELDS.split(","))


def probe_frequency(client, frequency):
    rows = client.rows(
        "stk_mins",
        {
            "ts_code": CODE,
            "freq": frequency,
            "start_date": START,
            "end_date": END,
        },
        FIELDS,
    )
    if not rows:
        raise RuntimeError(f"{frequency} 返回空数据")

    fields = set(rows[0])
    missing = sorted(REQUIRED_FIELDS - fields)
    if missing:
        raise RuntimeError(f"{frequency} 缺少字段: {missing}")

    times = sorted(str(row["trade_time"]) for row in rows)
    numeric_fields = ("open", "close", "high", "low", "vol", "amount")
    invalid_numeric = 0
    amount_nonzero = 0
    for row in rows:
        for field in numeric_fields:
            try:
                value = float(row[field])
            except (TypeError, ValueError):
                invalid_numeric += 1
                continue
            if not math.isfinite(value):
                invalid_numeric += 1
        try:
            if float(row["amount"]) > 0:
                amount_nonzero += 1
        except (TypeError, ValueError):
            pass

    if invalid_numeric:
        raise RuntimeError(
            f"{frequency} 含 {invalid_numeric} 个非法数值字段"
        )
    return {
        "frequency": frequency,
        "rows": len(rows),
        "fields": sorted(fields),
        "first_time": times[0],
        "last_time": times[-1],
        "amount_nonzero_ratio": round(amount_nonzero / len(rows), 4),
    }


def main():
    client = TushareClient(max_per_min=30)
    result = {
        "api": "stk_mins",
        "code": CODE,
        "start": START,
        "end": END,
        "probes": [
            probe_frequency(client, "1min"),
            probe_frequency(client, "5min"),
        ],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("STK_MINS_ACCESS_OK")


if __name__ == "__main__":
    main()
