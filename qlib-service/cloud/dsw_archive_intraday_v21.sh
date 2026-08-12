#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_archive_intraday_v21.sh RUN_ID" >&2
  exit 64
fi

SOURCE="${ROOT}/minute-runs/${RUN_ID}/v21"
TARGET_PREFIX="datasets/runs/${RUN_ID}/v21/"
MANIFEST="${SOURCE}/v21_sha256_manifest.txt"
PYTHON="${ROOT}/.venv-torch/bin/python"
FILES=(
  intraday_v21_dual_head.npz
  v21_intraday.pt
  v21_metrics.json
  v21_holdout_predictions.npz
  v21_gate.json
)

cd "${ROOT}"
test -x "${PYTHON}"
for file in "${FILES[@]}"; do
  test -f "${SOURCE}/${file}"
done

(
  cd "${SOURCE}"
  sha256sum "${FILES[@]}" > "$(basename "${MANIFEST}")"
)

"${PYTHON}" - "${SOURCE}" "${TARGET_PREFIX}" <<'PY'
import os
import sys

import oss2
from alibabacloud_credentials import providers

source, target_prefix = sys.argv[1:3]
bucket_name = os.environ["LAB_OSS_BUCKET"]
endpoint = os.environ.get(
    "LAB_OSS_ENDPOINT",
    "https://oss-cn-hangzhou-internal.aliyuncs.com",
)
auth = oss2.ProviderAuth(providers.DefaultCredentialsProvider())
bucket = oss2.Bucket(auth, endpoint, bucket_name)
files = (
    "intraday_v21_dual_head.npz",
    "v21_intraday.pt",
    "v21_metrics.json",
    "v21_holdout_predictions.npz",
    "v21_gate.json",
    "v21_sha256_manifest.txt",
)
existing = [
    target_prefix + name
    for name in files
    if bucket.object_exists(target_prefix + name)
]
if existing:
    raise SystemExit(f"V21_ARCHIVE_TARGET_EXISTS {existing[0]}")
for name in files:
    oss2.resumable_upload(
        bucket,
        target_prefix + name,
        os.path.join(source, name),
        multipart_threshold=100 * 1024 * 1024,
        part_size=10 * 1024 * 1024,
        num_threads=4,
    )
print(f"INTRADAY_V21_ARCHIVE_OK oss://{bucket_name}/{target_prefix}")
PY

echo "INTRADAY_V21_ARCHIVE_COMPLETE ${RUN_ID}"
