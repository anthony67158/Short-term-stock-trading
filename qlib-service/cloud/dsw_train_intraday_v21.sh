#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_train_intraday_v21.sh RUN_ID" >&2
  exit 64
fi

CACHE_ROOT="${ROOT}/minute-cache/5min-v1"
DOWNLOAD_REPORT="${ROOT}/minute-runs/${RUN_ID}/minute_5m_download.json"
OUTPUT_DIR="${ROOT}/minute-runs/${RUN_ID}/v21"
DATASET="${OUTPUT_DIR}/intraday_v21_dual_head.npz"
METRICS="${OUTPUT_DIR}/v21_metrics.json"
GATE="${OUTPUT_DIR}/v21_gate.json"
PYTHON="${ROOT}/.venv-torch/bin/python"

cd "${ROOT}"
test -x "${PYTHON}"
test -f build_intraday_v21_dataset.py
test -f train_intraday_v21.py
test -f intraday_v21_gate.py
test -f "${DOWNLOAD_REPORT}"

export QUANT_ENVIRONMENT=lab
export LAB_OSS_BUCKET=stock-quant-lab-1730034925594178
export LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/v21/"
"${PYTHON}" cloud/isolation_guard.py --check

"${PYTHON}" - "${DOWNLOAD_REPORT}" <<'PY'
import json
import sys

from minute_data import validate_download_report_for_training

with open(sys.argv[1], encoding="utf-8") as handle:
    report = json.load(handle)
quality = validate_download_report_for_training(report)
print("V21_MINUTE_DOWNLOAD_VALIDATED", json.dumps(quality, ensure_ascii=False))
PY

mkdir -p "${OUTPUT_DIR}"
if test -f "${DATASET}"; then
  echo "V21_DATASET_CACHE_HIT ${DATASET}"
else
  "${PYTHON}" build_intraday_v21_dataset.py \
    --cache-root "${CACHE_ROOT}" \
    --out "${DATASET}" \
    --sequence-length 60 \
    --minimum-bars-per-day 40
fi

"${PYTHON}" train_intraday_v21.py \
  --data "${DATASET}" \
  --out-dir "${OUTPUT_DIR}" \
  --seed 42 \
  --batch-size 512 \
  --max-epochs 40 \
  --patience 6

"${PYTHON}" intraday_v21_gate.py \
  --metrics "${METRICS}" \
  --out "${GATE}"

"${PYTHON}" - "${GATE}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    gate = json.load(handle)
if not gate.get("production_eligible"):
    raise SystemExit("V2.1_OFFLINE_GATE_REJECTED")
print("V2.1_OFFLINE_GATE_PASSED")
PY

echo "INTRADAY_V21_PIPELINE_OK ${RUN_ID}"
