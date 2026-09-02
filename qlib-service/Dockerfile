# 阿里云 FC 3.0 容器运行时备用方案；平台会注入 $PORT。
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# lightgbm 运行时依赖 libgomp
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 使用阿里云 PyPI 镜像，保持构建链路与部署平台一致。
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/

# 先装依赖（利用镜像层缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py factors_lib.py model_lib.py opportunity_contract.py opportunity_evaluation.py opportunity_model.py sector_contract.py sector_factors.py sector_model.py ./
COPY contracts/opportunity-score-features.json ./contracts/
COPY lgb_score.txt meta.json lgb_signal.txt signal_meta.json event_tags.json ./
COPY sector_next_lgb.txt sector_week_lgb.txt sector_meta.json ./

# FC 容器函数会注入 PORT，未注入时默认监听 80。
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-80} --workers 1
