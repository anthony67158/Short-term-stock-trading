#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_train_intraday_tcn.sh RUN_ID" >&2
  exit 64
fi
CACHE_ROOT="${ROOT}/minute-cache/5min-v1"
DOWNLOAD_REPORT="${ROOT}/minute-runs/${RUN_ID}/minute_5m_download.json"
OUTPUT_DIR="${ROOT}/minute-runs/${RUN_ID}/tcn"
DATASET="${OUTPUT_DIR}/intraday_5m_t1.npz"
PYTHON="${ROOT}/.venv-torch/bin/python"

cd "${ROOT}"
test -x "${PYTHON}"
test -f build_intraday_dataset.py
test -f train_intraday_tcn.py
test -f "${DOWNLOAD_REPORT}"

export QUANT_ENVIRONMENT=lab
export LAB_OSS_BUCKET=stock-quant-lab-1730034925594178
export LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/"
"${PYTHON}" cloud/isolation_guard.py --check

"${PYTHON}" - "${DOWNLOAD_REPORT}" <<'PY'
import json
import sys

from minute_data import validate_download_report_for_training

with open(sys.argv[1], encoding="utf-8") as handle:
    report = json.load(handle)
quality = validate_download_report_for_training(report)
print("MINUTE_DOWNLOAD_VALIDATED", json.dumps(quality, ensure_ascii=False))
PY

mkdir -p "${OUTPUT_DIR}"
if test -f "${DATASET}"; then
  echo "INTRADAY_DATASET_CACHE_HIT ${DATASET}"
else
  "${PYTHON}" build_intraday_dataset.py \
    --cache-root "${CACHE_ROOT}" \
    --out "${DATASET}" \
    --sequence-length 60 \
    --minimum-bars-per-day 40 \
    --take-profit-pct 0.01 \
    --stop-loss-pct 0.006
fi

"${PYTHON}" train_intraday_tcn.py \
  --data "${DATASET}" \
  --out-dir "${OUTPUT_DIR}" \
  --seed 42 \
  --batch-size 512 \
  --max-epochs 40 \
  --patience 6
