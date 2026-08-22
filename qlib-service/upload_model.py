"""
上传训练好的模型到 OSS（前缀 quantmodel/），供量化服务运行时拉取。
读取 .env 里的 OSS_* 变量。用法：
  set -a; source ../.env; set +a
  python3 upload_model.py --model lgb_score.txt --meta meta.json
"""
import argparse
import hashlib
import json
import os
import re
import time


def bucket():
    import oss2
    ak = os.environ["OSS_ACCESS_KEY_ID"]
    sk = os.environ["OSS_ACCESS_KEY_SECRET"]
    bkt = os.environ["OSS_BUCKET"]
    endpoint = os.environ.get("OSS_ENDPOINT")
    if not endpoint:
        region = os.environ.get("OSS_REGION", "oss-cn-hangzhou")
        if not region.startswith("oss-"):
            region = "oss-" + region
        endpoint = f"https://{region}.aliyuncs.com"
    return oss2.Bucket(oss2.Auth(ak, sk), endpoint, bkt)


def release_id(meta):
    value = str(meta.get("run_id") or "").strip()
    if not value:
        trained_at = int(meta.get("trained_at") or time.time())
        value = f"run-{trained_at}"
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", value)
        or ".." in value
    ):
        raise ValueError("run_id 格式无效")
    return value


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def publish_release(
    target_bucket,
    files,
    *,
    prefix,
    run_id,
    activated_at=None,
):
    normalized_prefix = str(prefix or "quantmodel/").strip("/")
    base = f"{normalized_prefix}/runs/{run_id}"
    manifest_files = {}
    for slot, local, filename in files:
        if not os.path.isfile(local):
            raise FileNotFoundError(local)
        key = f"{base}/{filename}"
        target_bucket.put_object_from_file(
            key,
            local,
            headers={"x-oss-forbid-overwrite": "true"},
        )
        manifest_files[slot] = {
            "key": key,
            "sha256": _sha256(local),
            "size": os.path.getsize(local),
        }
        print(f"[uploaded] {local} -> {key}")
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "activated_at": int(activated_at or time.time()),
        "files": manifest_files,
    }
    manifest_key = f"{normalized_prefix}/manifest.json"
    target_bucket.put_object(
        manifest_key,
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    print(f"[activated] {manifest_key} -> {run_id}")
    return manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="lgb_score.txt")
    ap.add_argument("--meta", default="meta.json")
    ap.add_argument("--signal", default=None, help="信号头模型(lgb_signal.txt)，可选")
    ap.add_argument("--signal-meta", default=None, help="信号头元数据(signal_meta.json)，可选")
    ap.add_argument("--event-tags", default=None, help="事件确认高把握标记(event_tags.json)，可选")
    ap.add_argument("--prefix", default=os.environ.get("QUANT_MODEL_PREFIX", "quantmodel/"))
    a = ap.parse_args()
    b = bucket()
    with open(a.meta, encoding="utf-8") as handle:
        metadata = json.load(handle)
    run_id = release_id(metadata)
    pairs = [
        ("model", a.model, "lgb_score.txt"),
        ("meta", a.meta, "meta.json"),
    ]
    if a.signal and os.path.exists(a.signal):
        pairs.append(("signal_model", a.signal, "lgb_signal.txt"))
    if a.signal_meta and os.path.exists(a.signal_meta):
        pairs.append(("signal_meta", a.signal_meta, "signal_meta.json"))
    if a.event_tags and os.path.exists(a.event_tags):
        pairs.append(("event_tags", a.event_tags, "event_tags.json"))
    manifest = publish_release(
        b,
        pairs,
        prefix=a.prefix,
        run_id=run_id,
    )
    # 读回校验
    got = b.head_object(manifest["files"]["model"]["key"])
    print(f"[verify] model size on OSS = {got.content_length} bytes")


if __name__ == "__main__":
    main()
