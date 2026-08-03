# CloudBase 云托管 / Cloud Run 通用；平台会注入 $PORT，uvicorn 必须监听它
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# lightgbm 运行时依赖 libgomp
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 用腾讯云 pip 镜像源加速构建（CloudBase 构建时在国内）
RUN pip config set global.index-url https://mirrors.cloud.tencent.com/pypi/simple

# 先装依赖（利用镜像层缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py factors_lib.py model_lib.py ./

# CloudBase 默认监听 80；Cloud Run 默认 8080。用 $PORT 自适应两者
CMD exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-80} --workers 1
