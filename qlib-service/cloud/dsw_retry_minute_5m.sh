#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_retry_minute_5m.sh RUN_ID" >&2
  exit 64
fi
RAW_ROOT="${ROOT}/minute-cache/5min-v1"
RUN_DIR="${ROOT}/minute-runs/${RUN_ID}"
REPORT="${RUN_DIR}/minute_5m_download.json"
PYTHON="${ROOT}/.venv/bin/python"

cd "${ROOT}"
test -x "${PYTHON}"
test -f minute_data.py
test -f tushare_client.py
test -f "${REPORT}"

export QUANT_ENVIRONMENT=lab
export LAB_OSS_BUCKET=stock-quant-lab-1730034925594178
export LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/"
"${PYTHON}" cloud/isolation_guard.py --check

read -rsp "Tushare Token: " TUSHARE_TOKEN
echo
export TUSHARE_TOKEN
trap 'unset TUSHARE_TOKEN' EXIT

PYTHONPATH="${ROOT}" "${PYTHON}" - "${RAW_ROOT}" "${REPORT}" <<'PY'
import json
import os
import sys
import tempfile
from pathlib import Path

from minute_data import retry_failed_slices
from tushare_client import TushareClient

raw_root = sys.argv[1]
report_path = Path(sys.argv[2])
report = json.loads(report_path.read_text(encoding="utf-8"))
summary = retry_failed_slices(
    TushareClient(max_per_min=45),
    root=raw_root,
    frequency="5min",
    report=report,
    allow_source_row_drops=True,
    minimum_valid_bars_per_day=40,
    max_source_day_drop_fraction=0.05,
)
descriptor, temporary = tempfile.mkstemp(
    prefix=".minute-report-",
    suffix=".json",
    dir=report_path.parent,
)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, report_path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
if summary["failed_slices"]:
    raise SystemExit("MINUTE_5M_RETRY_INCOMPLETE")
if summary["completed_slices"] != summary["requested_slices"]:
    raise SystemExit("MINUTE_5M_RETRY_COUNT_MISMATCH")
print("MINUTE_5M_RETRY_OK")
PY
