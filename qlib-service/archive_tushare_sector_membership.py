"""Fetch and publish historical SW2021 sector membership."""

import argparse
import gzip
import json
import os

from model_lib import _oss_bucket
from opportunity_sector_archive import (
    build_sector_membership_artifact,
    publish_sector_membership,
)
from tushare_client import TushareClient


def archive_sector_membership(*, output=None, publish=False):
    client = TushareClient()
    rows = client.index_member_all()
    artifact = build_sector_membership_artifact(rows)
    if output:
        target = os.path.abspath(output)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = target + ".part"
        with gzip.open(temporary, "wt", encoding="utf-8") as handle:
            json.dump(
                artifact,
                handle,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        os.replace(temporary, target)
    manifest = None
    if publish:
        bucket = _oss_bucket()
        if bucket is None:
            raise RuntimeError("行业成员OSS未配置")
        manifest = publish_sector_membership(
            bucket,
            artifact["memberships"],
            generated_at=artifact["generatedAt"],
        )
    return {
        "ok": True,
        **artifact["summary"],
        "output": os.path.abspath(output) if output else None,
        "published": manifest is not None,
        "key": manifest["key"] if manifest else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if not args.output and not args.publish:
        raise ValueError("至少指定 --output 或 --publish")
    print(json.dumps(
        archive_sector_membership(
            output=args.output,
            publish=args.publish,
        ),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
