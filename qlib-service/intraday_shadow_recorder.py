"""Persist non-actionable shadow predictions to the isolated lab bucket."""

import json
import os
import re
import time
from datetime import datetime


TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LAB_BUCKET_PREFIX = "stock-quant-lab-"
SHADOW_PREFIX = "shadow/predictions/"


def build_shadow_record(prediction, *, recorded_at=None):
    """Whitelist fields so raw bars and production decisions cannot be stored."""
    if not isinstance(prediction, dict):
        raise ValueError("prediction 必须是对象")
    return {
        "schemaVersion": 1,
        "recordedAt": int(time.time() if recorded_at is None else recorded_at),
        "requestId": prediction.get("requestId"),
        "code": prediction["code"],
        "asOf": prediction["asOf"],
        "model": prediction["model"],
        "probabilities": prediction["probabilities"],
        "outlook": prediction.get("outlook"),
        "targetDefinition": prediction.get("targetDefinition"),
        "marketContext": prediction.get("marketContext"),
        "priceReferences": prediction.get("priceReferences"),
        "predictedClass": prediction["predictedClass"],
        "shadowOnly": True,
    }


def shadow_record_key(prediction):
    as_of = prediction.get("asOf")
    try:
        signal_date = datetime.strptime(as_of, TIME_FORMAT).strftime("%Y-%m-%d")
    except (TypeError, ValueError) as error:
        raise ValueError("影子预测 asOf 无效") from error
    request_id = prediction.get("requestId")
    if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
        code = str(prediction.get("code") or "").replace(".", "_")
        request_id = f"{signal_date.replace('-', '')}_{code}"
    return f"{SHADOW_PREFIX}{signal_date}/{request_id}.json"


class OssShadowRecorder:
    def __init__(
        self,
        *,
        bucket_name,
        expected_bucket,
        endpoint,
        access_key_id="",
        access_key_secret="",
        security_token="",
    ):
        if (
            not isinstance(bucket_name, str)
            or not bucket_name.startswith(LAB_BUCKET_PREFIX)
            or bucket_name != expected_bucket
        ):
            raise RuntimeError("影子记录器拒绝非实验 OSS Bucket")
        if not isinstance(endpoint, str) or not endpoint:
            raise RuntimeError("影子记录器 OSS 配置不完整")
        import oss2

        if access_key_id or access_key_secret:
            if not all(
                isinstance(value, str) and value
                for value in (access_key_id, access_key_secret)
            ):
                raise RuntimeError("影子记录器 OSS 配置不完整")
            auth = (
                oss2.StsAuth(
                    access_key_id,
                    access_key_secret,
                    security_token,
                )
                if security_token
                else oss2.Auth(access_key_id, access_key_secret)
            )
        else:
            try:
                from alibabacloud_credentials import providers
            except ImportError as error:
                raise RuntimeError("影子记录器缺少 STS 凭证组件") from error
            auth = oss2.ProviderAuth(
                providers.DefaultCredentialsProvider()
            )

        self.bucket = oss2.Bucket(
            auth,
            endpoint,
            bucket_name,
        )

    @classmethod
    def from_environment(cls):
        bucket = os.environ.get("LAB_OSS_BUCKET", "")
        region = os.environ.get("OSS_REGION", "oss-cn-hangzhou")
        if not region.startswith("oss-"):
            region = f"oss-{region}"
        endpoint = os.environ.get(
            "OSS_ENDPOINT",
            f"https://{region}-internal.aliyuncs.com",
        )
        return cls(
            bucket_name=bucket,
            expected_bucket=os.environ.get("EXPECTED_LAB_OSS_BUCKET", ""),
            endpoint=endpoint,
            access_key_id=os.environ.get("OSS_ACCESS_KEY_ID", ""),
            access_key_secret=os.environ.get("OSS_ACCESS_KEY_SECRET", ""),
            security_token=os.environ.get("OSS_SESSION_TOKEN", ""),
        )

    def record(self, prediction):
        record = build_shadow_record(prediction)
        payload = json.dumps(
            record,
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        self.bucket.put_object(shadow_record_key(record), payload)
