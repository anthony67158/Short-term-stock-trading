#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-run-20260811-minute5m}
RAW_ROOT="${ROOT}/minute-cache/5min-v1"
RUN_DIR="${ROOT}/minute-runs/${RUN_ID}"
REPORT="${RUN_DIR}/minute_5m_download.json"
PYTHON="${ROOT}/.venv/bin/python"

cd "${ROOT}"
test -x "${PYTHON}"
test -f minute_data.py
test -f tushare_client.py
test -f pool_cache.json

export QUANT_ENVIRONMENT=lab
export LAB_OSS_BUCKET=stock-quant-lab-1730034925594178
export LAB_MODEL_PREFIX="models/challengers/${RUN_ID}/"
"${PYTHON}" cloud/isolation_guard.py --check

mkdir -p "${RAW_ROOT}" "${RUN_DIR}"
read -rsp "Tushare Token: " TUSHARE_TOKEN
echo
export TUSHARE_TOKEN
trap 'unset TUSHARE_TOKEN' EXIT

PYTHONPATH="${ROOT}" "${PYTHON}" - "${RAW_ROOT}" "${REPORT}" <<'PY'
import json
import sys
from datetime import datetime
from pathlib import Path

from minute_data import download_universe
from tushare_client import TushareClient

raw_root = sys.argv[1]
report_path = Path(sys.argv[2])
pool = json.loads(Path("pool_cache.json").read_text())
codes = [item[0] if isinstance(item, list) else item for item in pool]

summary = download_universe(
    TushareClient(max_per_min=45),
    root=raw_root,
    frequency="5min",
    codes=codes,
    start=datetime(2024, 1, 1, 9, 30),
    end=datetime(2026, 7, 29, 15, 0),
    months_per_request=6,
)
report_path.write_text(
    json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
)
print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
if summary["failed_slices"]:
    raise SystemExit("MINUTE_5M_DOWNLOAD_INCOMPLETE")
print("MINUTE_5M_DOWNLOAD_OK")
PY
