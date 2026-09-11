#!/usr/bin/env bash
# Deploy quant-score to Alibaba Cloud Function Compute 3.0.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PKG="$HERE/deploy_pkg"

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env"
  exit 1
fi

if [ ! -d "$PKG/deps" ]; then
  bash "$HERE/build_deploy_pkg.sh"
else
  cp \
    "$HERE/app.py" \
    "$HERE/factors_lib.py" \
    "$HERE/model_lib.py" \
    "$HERE/opportunity_market_archive.py" \
    "$HERE/archive_public_market_day.py" \
    "$HERE/sector_contract.py" \
    "$HERE/sector_factors.py" \
    "$HERE/sector_model.py" \
    "$HERE/lgb_score.txt" \
    "$HERE/meta.json" \
    "$HERE/bootstrap" \
    "$PKG/"
  rm -rf "$PKG/decision_engine"
  cp -R "$HERE/decision_engine" "$PKG/decision_engine"
  find "$PKG/decision_engine" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
  rm -f \
    "$PKG/opportunity_contract.py" \
    "$PKG/opportunity_evaluation.py" \
    "$PKG/opportunity_model.py"
  mkdir -p "$PKG/contracts"
  cp "$HERE/contracts/opportunity-score-features.json" "$PKG/contracts/"
  for file in \
    lgb_signal.txt \
    signal_meta.json \
    event_tags.json \
    sector_next_lgb.txt \
    sector_week_lgb.txt \
    sector_meta.json
  do
    if [ -f "$HERE/$file" ]; then cp "$HERE/$file" "$PKG/"; fi
  done
  chmod +x "$PKG/bootstrap"
fi

set -a
. "$ROOT/.env"
set +a

cd "$HERE"
npx @serverless-devs/s deploy -y

curl --fail --silent --show-error \
  "https://quant-score-nlxgclpdbu.cn-hangzhou.fcapp.run/health"
printf '\nAlibaba Cloud FC deployment verified.\n'
