#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_bakeoff_intraday.sh RUN_ID" >&2
  exit 64
fi
OUTPUT_DIR="${ROOT}/minute-runs/${RUN_ID}/tcn"
DATASET="${OUTPUT_DIR}/intraday_5m_t1.npz"
PYTHON="${ROOT}/.venv-torch/bin/python"

cd "${ROOT}"
test -x "${PYTHON}"
test -f "${DATASET}"
test -f "${OUTPUT_DIR}/tcn.pt"

export QUANT_ENVIRONMENT=lab
export LAB_OSS_BUCKET=stock-quant-lab-1730034925594178
export LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/"
"${PYTHON}" cloud/isolation_guard.py --check

for architecture in gru transformer; do
  if test -f "${OUTPUT_DIR}/${architecture}_metrics.json"; then
    echo "BAKEOFF_CACHE_HIT ${architecture}"
    continue
  fi
  "${PYTHON}" train_intraday_tcn.py \
    --data "${DATASET}" \
    --out-dir "${OUTPUT_DIR}" \
    --architecture "${architecture}" \
    --seed 42 \
    --batch-size 512 \
    --max-epochs 40 \
    --patience 6
done

"${PYTHON}" - "${OUTPUT_DIR}" <<'PY'
import json
import os
import sys

root = sys.argv[1]
metrics = {}
for architecture in ("tcn", "gru", "transformer"):
    path = os.path.join(root, f"{architecture}_metrics.json")
    with open(path, encoding="utf-8") as handle:
        current = json.load(handle)
    metrics[architecture] = {
        key: current[key]
        for key in (
            "holdout_log_loss",
            "holdout_macro_f1",
            "holdout_balanced_accuracy",
            "best_epoch",
        )
    }
with open(os.path.join(root, "bakeoff_metrics.json"), "w", encoding="utf-8") as handle:
    json.dump(metrics, handle, ensure_ascii=False, indent=2)
print(json.dumps(metrics, ensure_ascii=False, indent=2))
print("INTRADAY_BAKEOFF_OK")
PY
