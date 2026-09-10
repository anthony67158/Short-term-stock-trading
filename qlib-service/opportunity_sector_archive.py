"""Versioned historical sector membership for causal V3 replay."""

import gzip
import hashlib
import json
import re
import time


SCHEMA_VERSION = "opportunity-sector-membership.v1"
MANIFEST_SCHEMA_VERSION = "opportunity-sector-membership-manifest.v1"
PREFIX = "opportunitymodel/sector-data/v1"
MANIFEST_KEY = f"{PREFIX}/manifest.json"
CODE = re.compile(r"^\d{6}$")
DATE = re.compile(r"^\d{8}$")


def _code(value):
    text = str(value or "").upper()
    match = re.fullmatch(r"(\d{6})(?:\.(?:SH|SZ|BJ))?", text)
    return match.group(1) if match else None


def _date(value, fallback=None):
    text = re.sub(r"\D", "", str(value or ""))
    if not text:
        return fallback
    if not DATE.fullmatch(text):
        raise ValueError("行业成员日期无效")
    return text


def normalize_sector_memberships(values):
    unique = {}
    for value in values if isinstance(values, list) else []:
        code = _code((value or {}).get("ts_code") or (value or {}).get("code"))
        sector_code = str(
            (value or {}).get("l1_code")
            or (value or {}).get("sectorCode")
            or ""
        ).strip()
        sector_name = str(
            (value or {}).get("l1_name")
            or (value or {}).get("sectorName")
            or ""
        ).strip()
        if not code or not sector_code or not sector_name:
            continue
        in_date = _date((value or {}).get("in_date"), "19000101")
        out_date = _date((value or {}).get("out_date"), None)
        if out_date and out_date < in_date:
            raise ValueError("行业成员生效区间倒置")
        item = {
            "code": code,
            "sectorCode": sector_code[:20],
            "sectorName": sector_name[:60],
            "inDate": in_date,
            "outDate": out_date,
        }
        key = (
            item["code"],
            item["sectorCode"],
            item["inDate"],
            item["outDate"] or "",
        )
        unique[key] = item
    return sorted(
        unique.values(),
        key=lambda item: (
            item["code"],
            item["inDate"],
            item["sectorCode"],
        ),
    )


def build_sector_membership_artifact(values, *, generated_at=None):
    memberships = normalize_sector_memberships(values)
    if len(memberships) < 800:
        raise ValueError("行业成员覆盖不足800只")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": int(generated_at or time.time() * 1000),
        "source": "TUSHARE_INDEX_MEMBER_ALL_SW2021",
        "summary": {
            "memberships": len(memberships),
            "codes": len({item["code"] for item in memberships}),
            "sectors": len({
                item["sectorCode"]
                for item in memberships
            }),
        },
        "memberships": memberships,
    }


def encode_sector_membership(artifact):
    raw = json.dumps(
        artifact,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0)


def publish_sector_membership(bucket, values, *, generated_at=None):
    artifact = build_sector_membership_artifact(
        values,
        generated_at=generated_at,
    )
    encoded = encode_sector_membership(artifact)
    digest = hashlib.sha256(encoded).hexdigest()
    key = f"{PREFIX}/runs/{artifact['generatedAt']}-{digest[:16]}.json.gz"
    bucket.put_object(
        key,
        encoded,
        headers={"x-oss-forbid-overwrite": "true"},
    )
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "activatedAt": artifact["generatedAt"],
        "key": key,
        "sha256": digest,
        "size": len(encoded),
        "summary": artifact["summary"],
    }
    bucket.put_object(
        MANIFEST_KEY,
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={"Cache-Control": "no-cache"},
    )
    return manifest


def load_sector_membership(bucket):
    try:
        manifest = json.loads(
            bucket.get_object(MANIFEST_KEY).read().decode("utf-8")
        )
    except Exception as error:
        if (
            isinstance(error, KeyError)
            or getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return []
        raise
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("行业成员清单版本无效")
    encoded = bucket.get_object(manifest["key"]).read()
    if hashlib.sha256(encoded).hexdigest() != manifest.get("sha256"):
        raise ValueError("行业成员摘要校验失败")
    artifact = json.loads(gzip.decompress(encoded).decode("utf-8"))
    if artifact.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("行业成员内容版本无效")
    memberships = normalize_sector_memberships(
        artifact.get("memberships")
    )
    if len(memberships) != int(
        artifact.get("summary", {}).get("memberships") or 0
    ):
        raise ValueError("行业成员数量校验失败")
    return memberships
