"""Publish a validated compact opportunity-history baseline to OSS."""

import argparse
import json

from model_lib import _oss_bucket
from opportunity_history import publish_opportunity_history


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    with open(args.input, encoding="utf-8") as handle:
        payload = json.load(handle)
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("机会历史样本OSS未配置")
    manifest = publish_opportunity_history(bucket, payload)
    print(json.dumps({
        "ok": True,
        "key": manifest["key"],
        **manifest["summary"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
