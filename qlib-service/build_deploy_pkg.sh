#!/usr/bin/env bash
# ============================================================
# 重建量化服务「免 Docker」部署包 deploy_pkg/
# 背景：quant-score 用 FC3.0 custom.debian10 自定义运行时(不用 Docker)。
#   Python 依赖(lightgbm/arch/statsmodels/scipy/pandas/numpy/oss2 + fastapi/uvicorn 等)
#   以 linux cp310 wheel 形式 vendored 到 deploy_pkg/deps/，随代码一起上传。
#   deploy_pkg/deps/ 体积约 300M，已在 .gitignore，用本脚本按需重建。
# 用法： bash build_deploy_pkg.sh    然后 set -a; source ../.env; set +a; s deploy -y
# 说明：需能访问 pypi.org（内网镜像缺 lightgbm 4.x）。
# ============================================================
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/deploy_pkg"
VEND=/tmp/qvend
IDX="https://pypi.org/simple"

rm -rf "$VEND" "$PKG/deps"; mkdir -p "$VEND" "$PKG/deps"

# --- 1) 重依赖(编译型 cp310 wheel) ---
# 注意 lightgbm 4.x 只发 manylinux_2_28 tag(FC debian10 glibc>=2.28,兼容)
pip download --no-deps --only-binary=:all: --index-url "$IDX" \
  --platform manylinux_2_28_x86_64 --python-version 310 --implementation cp --abi cp310 \
  -d "$VEND" "lightgbm==4.6.0"
pip download --no-deps --only-binary=:all: --index-url "$IDX" \
  --platform manylinux_2_17_x86_64 --python-version 310 --implementation cp --abi cp310 \
  -d "$VEND" "arch==7.2.0" "statsmodels==0.14.4" "scipy==1.14.1" "pandas==2.2.3" "numpy==2.0.2"

# --- 2) OSS + web 框架 + 纯 Python 依赖 ---
PURE="oss2==2.19.1 crcmod==1.7 pycryptodome==3.21.0 aliyun-python-sdk-core==2.16.0 \
aliyun-python-sdk-kms==2.16.5 requests==2.32.3 urllib3==2.2.3 charset-normalizer==3.4.0 \
certifi==2024.8.30 idna==3.10 jmespath==0.10.0 six==1.16.0 cryptography==43.0.3 cffi==1.17.1 \
pycparser==2.22 python-dateutil==2.9.0.post0 pytz==2024.2 tzdata==2024.2 patsy==1.0.1 packaging==24.1 \
fastapi==0.115.14 uvicorn==0.34.3 starlette==0.46.2 pydantic==2.13.4 pydantic-core==2.46.4 \
anyio==4.14.2 sniffio==1.3.1 h11==0.16.0 click==8.4.2 annotated-types==0.8.0 \
typing-extensions==4.15.0 typing-inspection==0.4.2 exceptiongroup==1.3.1 httptools==0.8.0 \
uvloop==0.22.1 watchfiles==1.1.1 websockets==16.0 pyyaml==6.0.3 python-dotenv==1.2.2"
for p in $PURE; do
  pip download --no-deps --only-binary=:all: --index-url "$IDX" \
    --platform manylinux_2_17_x86_64 --python-version 310 --implementation cp --abi cp310 \
    -d "$VEND" "$p" 2>/dev/null \
  || pip download --no-deps --index-url "$IDX" -d "$VEND" "$p"
done

# --- 3) 解包到 deps/(wheel 直接 unzip，sdist 用 pip 装) ---
for w in "$VEND"/*.whl; do unzip -oq "$w" -d "$PKG/deps" -x "*.dist-info/RECORD" 2>/dev/null || true; done
for s in "$VEND"/*.tar.gz; do pip install --no-deps --no-compile --target "$PKG/deps" "$s"; done

# --- 4) 瘦身：删测试/文档/pyc ---
find "$PKG/deps" -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
find "$PKG/deps" -type d -name test  -prune -exec rm -rf {} + 2>/dev/null || true
find "$PKG/deps" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$PKG/deps" -name "*.pyc" -delete 2>/dev/null || true

# --- 5) 拷贝源码 + bundled 模型 + bootstrap(这些进 git) ---
cp "$HERE/app.py" "$HERE/factors_lib.py" "$HERE/model_lib.py" \
   "$HERE/sector_contract.py" "$HERE/sector_factors.py" \
   "$HERE/sector_model.py" \
   "$HERE/lgb_score.txt" "$HERE/meta.json" "$HERE/bootstrap" "$PKG/"
for f in sector_next_lgb.txt sector_week_lgb.txt sector_meta.json; do
  if [ -f "$HERE/$f" ]; then cp "$HERE/$f" "$PKG/"; fi
done
chmod +x "$PKG/bootstrap"

echo "[done] deploy_pkg ready: $(du -sh "$PKG" | cut -f1)"
echo "接着： set -a; source ../.env; set +a && s deploy -y"
