#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
RUN_ID=${1:-}
if test -z "${RUN_ID}"; then
  echo "usage: dsw_archive_intraday_v21.sh RUN_ID" >&2
  exit 64
fi

SOURCE="${ROOT}/minute-runs/${RUN_ID}/v21"
TARGET="/mnt/data/runs/${RUN_ID}/v21"
MANIFEST="${SOURCE}/v21_sha256_manifest.txt"

cd "${ROOT}"
for file in \
  intraday_v21_dual_head.npz \
  v21_intraday.pt \
  v21_metrics.json \
  v21_holdout_predictions.npz \
  v21_gate.json
do
  test -f "${SOURCE}/${file}"
done

sha256sum \
  "${SOURCE}/intraday_v21_dual_head.npz" \
  "${SOURCE}/v21_intraday.pt" \
  "${SOURCE}/v21_metrics.json" \
  "${SOURCE}/v21_holdout_predictions.npz" \
  "${SOURCE}/v21_gate.json" \
  > "${MANIFEST}"

if test -e "${TARGET}"; then
  echo "V21_ARCHIVE_TARGET_EXISTS ${TARGET}" >&2
  exit 2
fi
mkdir -p "${TARGET}"
cp \
  "${SOURCE}/intraday_v21_dual_head.npz" \
  "${SOURCE}/v21_intraday.pt" \
  "${SOURCE}/v21_metrics.json" \
  "${SOURCE}/v21_holdout_predictions.npz" \
  "${SOURCE}/v21_gate.json" \
  "${MANIFEST}" \
  "${TARGET}/"

echo "INTRADAY_V21_ARCHIVE_OK ${TARGET}"
