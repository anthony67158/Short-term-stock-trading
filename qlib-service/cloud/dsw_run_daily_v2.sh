#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/workspace/quant-lab
PACKAGE=/mnt/workspace/quant-lab-v2.zip
cd "$ROOT"

mkdir -p full477
exec > >(tee -a full477/daily_v2_master.log) 2>&1

test -f "$PACKAGE"
test -f full477/run_id.txt
test -x .venv/bin/python

echo "[daily-v2] start $(date -Iseconds)"
unzip -o "$PACKAGE" -d "$ROOT"

.venv/bin/python build_dataset_v2.py \
  --panel panel_full477 \
  --out full477/dataset_v2.npz \
  --min-hist 60 \
  --barrier-horizon 5 \
  --horizons 1,3,5

.venv/bin/python train_daily_v2.py \
  --data full477/dataset_v2.npz \
  --out-dir full477/daily_v2

.venv/bin/python evaluate_daily_v2.py \
  --predictions full477/daily_v2/holdout_predictions.npz \
  --panel panel_full477 \
  --out full477/daily_v2/daily_v2_backtest.json \
  --top-k 3 \
  --minimum-probability 0.5

RUN_ID="$(tr -d '\r\n' < full477/run_id.txt)"
OSS_OUT="/mnt/data/runs/$RUN_ID/daily_v2"
mkdir -p "$OSS_OUT"
cp full477/dataset_v2.npz "$OSS_OUT/"
cp full477/daily_v2/*.txt "$OSS_OUT/"
cp full477/daily_v2/*.json "$OSS_OUT/"
cp full477/daily_v2/holdout_predictions.npz "$OSS_OUT/"
cp full477/daily_v2_master.log "$OSS_OUT/"
cp "$PACKAGE" "$OSS_OUT/"
sha256sum \
  full477/dataset_v2.npz \
  full477/daily_v2/*.txt \
  full477/daily_v2/*.json \
  full477/daily_v2/holdout_predictions.npz \
  "$PACKAGE" \
  | tee "$OSS_OUT/sha256sums.txt"

echo "[daily-v2] artifacts persisted to $OSS_OUT"
echo "DAILY_V2_PIPELINE_OK"
echo "[daily-v2] complete $(date -Iseconds)"
