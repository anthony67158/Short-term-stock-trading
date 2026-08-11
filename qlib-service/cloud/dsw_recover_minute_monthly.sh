#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_recover_minute_monthly.sh RUN_ID" >&2
  exit 64
fi
RAW_ROOT="${ROOT}/minute-cache/5min-v1"
RUN_DIR="${ROOT}/minute-runs/${RUN_ID}"
REPORT="${RUN_DIR}/minute_5m_download.json"
MONTHLY_REPORT="${RUN_DIR}/minute_5m_monthly_recovery.json"
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

PYTHONPATH="${ROOT}" "${PYTHON}" - \
  "${RAW_ROOT}" "${REPORT}" "${MONTHLY_REPORT}" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from minute_data import download_month, expand_failed_slices_by_month
from tushare_client import TushareClient

raw_root = sys.argv[1]
report_path = Path(sys.argv[2])
monthly_report_path = Path(sys.argv[3])
report = json.loads(report_path.read_text(encoding="utf-8"))
slices = expand_failed_slices_by_month(report.get("failed_slices", []))
client = TushareClient(max_per_min=45)
summary = {
    "parent_failed_slices": len(report.get("failed_slices", [])),
    "requested_month_slices": len(slices),
    "completed_month_slices": 0,
    "downloaded_month_slices": 0,
    "repaired_month_slices": 0,
    "cached_month_slices": 0,
    "rows": 0,
    "dropped_rows": 0,
    "dropped_trading_days": 0,
    "failed_month_slices": [],
}
for item in slices:
    try:
        result = download_month(
            client,
            root=raw_root,
            frequency="5min",
            code=item["code"],
            start=datetime.strptime(item["start"], "%Y-%m-%d %H:%M:%S"),
            end=datetime.strptime(item["end"], "%Y-%m-%d %H:%M:%S"),
            allow_source_row_drops=True,
            minimum_valid_bars_per_day=40,
            max_source_day_drop_fraction=0.10,
        )
    except Exception as error:  # noqa: BLE001
        summary["failed_month_slices"].append(
            {
                **item,
                "error_type": type(error).__name__,
                "error_message": str(error)[:240],
            }
        )
        continue
    summary["completed_month_slices"] += 1
    summary[f"{result['status']}_month_slices"] += 1
    summary["rows"] += result["rows"]
    summary["dropped_rows"] += result.get("dropped_rows", 0)
    summary["dropped_trading_days"] += result.get("dropped_trading_days", 0)

descriptor, temporary = tempfile.mkstemp(
    prefix=".monthly-recovery-",
    suffix=".json",
    dir=monthly_report_path.parent,
)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, monthly_report_path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
print("MINUTE_5M_MONTHLY_RECOVERY_COMPLETE")
PY
