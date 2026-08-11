#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_orchestrate_intraday.sh RUN_ID" >&2
  exit 64
fi
RUN_DIR="${ROOT}/minute-runs/${RUN_ID}"
REPORT="${RUN_DIR}/minute_5m_download.json"
PYTHON="${ROOT}/.venv/bin/python"
STATUS="/mnt/workspace/intraday_orchestrator_${RUN_ID}.status"
LOG="/mnt/workspace/intraday_orchestrator_${RUN_ID}.log"

write_status() {
  printf '%s stage=%s %s\n' "$(date -Is)" "${STAGE}" "$*" > "${STATUS}"
}

fail() {
  local exit_code=$?
  write_status "FAILED exit_code=${exit_code}"
  exit "${exit_code}"
}

STAGE=initializing
mkdir -p "${RUN_DIR}"
: > "${LOG}"
exec > "${LOG}" 2>&1
trap fail ERR

cd "${ROOT}"
test -x "${PYTHON}"
test -f cloud/dsw_train_intraday_tcn.sh
test -f cloud/dsw_bakeoff_intraday.sh
test -f cloud/dsw_archive_intraday.sh

STAGE=waiting_for_download
write_status "WAITING_FOR_COMPLETE_REPORT"
while true; do
  if test -f "${REPORT}"; then
    set +e
    "${PYTHON}" - "${REPORT}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    report = json.load(handle)
if report.get("failed_slices"):
    raise SystemExit(2)
if report.get("completed_slices") == report.get("requested_slices"):
    raise SystemExit(0)
raise SystemExit(1)
PY
    result=$?
    set -e
    if test "${result}" -eq 0; then
      break
    fi
    if test "${result}" -eq 2; then
      STAGE=download_failed
      write_status "FAILED_SLICES_PRESENT"
      exit 2
    fi
  fi
  write_status "DOWNLOAD_NOT_COMPLETE"
  sleep 120
done

STAGE=train_tcn
write_status "STARTED"
bash cloud/dsw_train_intraday_tcn.sh "${RUN_ID}"

STAGE=bakeoff
write_status "STARTED"
bash cloud/dsw_bakeoff_intraday.sh "${RUN_ID}"

STAGE=archive
write_status "STARTED"
bash cloud/dsw_archive_intraday.sh "${RUN_ID}"

STAGE=complete
write_status "INTRADAY_PIPELINE_COMPLETE"
printf 'INTRADAY_PIPELINE_COMPLETE %s\n' "${RUN_ID}"
