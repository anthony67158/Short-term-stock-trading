"""Rebuild the OSS opportunity-history baseline with planned-risk R labels."""

import json

from model_lib import _oss_bucket
from opportunity_history import (
    PLANNED_RISK_BASIS,
    load_opportunity_history,
    publish_opportunity_history,
)


def rebuild_opportunity_history(bucket):
    outcomes = load_opportunity_history(bucket)
    if not outcomes:
        raise RuntimeError("云端机会历史为空")
    manifest = publish_opportunity_history(
        bucket,
        {"outcomes": outcomes},
    )
    return {
        "ok": True,
        "riskBasis": PLANNED_RISK_BASIS,
        "samples": manifest["summary"]["samples"],
        "filledSamples": manifest["summary"]["filledSamples"],
        "dates": manifest["summary"]["dates"],
        "key": manifest["key"],
        "sha256": manifest["sha256"],
    }


def main():
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("机会历史OSS未配置")
    print(json.dumps(
        rebuild_opportunity_history(bucket),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
