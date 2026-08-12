"""Persist V2.1 predictions under an isolated OSS prefix."""

import json
import time
from datetime import datetime

from intraday_shadow_recorder import OssShadowRecorder


TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
V21_PREFIX = "shadow/v2.1-intraday/"


def build_v21_record(prediction, *, recorded_at=None):
    if not isinstance(prediction, dict):
        raise ValueError("V2.1 prediction 必须是对象")
    return {
        "schemaVersion": 1,
        "recordedAt": int(time.time() if recorded_at is None else recorded_at),
        "modelVersion": "v2.1-intraday",
        "requestId": prediction.get("requestId"),
        "code": prediction["code"],
        "asOf": prediction["asOf"],
        "session": prediction["session"],
        "model": prediction["model"],
        "heads": prediction["heads"],
        "marketContext": prediction.get("marketContext"),
        "priceReferences": prediction.get("priceReferences"),
    }


def v21_record_key(record):
    as_of = datetime.strptime(record["asOf"], TIME_FORMAT)
    request_id = str(record.get("requestId") or "").strip()
    if not request_id:
        request_id = (
            f"{as_of.strftime('%Y%m%d_%H%M')}_"
            f"{str(record['code']).replace('.', '_')}"
        )
    return (
        f"{V21_PREFIX}{as_of.strftime('%Y-%m-%d')}/"
        f"{request_id}.json"
    )


class OssV21Recorder(OssShadowRecorder):
    def record(self, prediction):
        record = build_v21_record(prediction)
        payload = json.dumps(
            record,
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        self.bucket.put_object(v21_record_key(record), payload)
