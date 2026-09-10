"""Refresh the compact five-day fund history used by online V3 decisions."""

import json

from model_lib import _oss_bucket
from opportunity_market_archive import refresh_recent_fund_history


def main():
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("市场归档OSS未配置")
    result = refresh_recent_fund_history(bucket)
    print(json.dumps({
        "schemaVersion": result["schemaVersion"],
        "dates": result["dates"],
        "stocks": len(result["stocks"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
