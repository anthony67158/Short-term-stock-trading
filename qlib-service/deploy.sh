#!/usr/bin/env bash
# ============================================================
# 一键部署量化打分服务到 Google Cloud Run
# 用法：先改下面 PROJECT_ID，然后 bash deploy.sh
# 前置：已装 gcloud CLI 并 gcloud auth login、已开通结算账号
# ============================================================
set -e

# ↓↓↓ 你唯一需要改的：填你的 GCP 项目 ID ↓↓↓
PROJECT_ID="改成你的项目ID"
# ↑↑↑ 例如 my-quant-123456 ↑↑↑

REGION="asia-east1"          # 台湾节点，离 A 股数据源近、延迟低
SERVICE="quant-score"

if [ "$PROJECT_ID" = "改成你的项目ID" ]; then
  echo "❌ 请先编辑 deploy.sh，把 PROJECT_ID 改成你的 GCP 项目 ID"
  exit 1
fi

# 生成一把 API 密钥（只在本地保存，用于给 Vercel 配置，防止接口被盗刷）
if [ -f DEPLOY_INFO.txt ] && grep -q API_KEY DEPLOY_INFO.txt; then
  API_KEY=$(grep API_KEY DEPLOY_INFO.txt | cut -d= -f2)
  echo "复用已有 API_KEY"
else
  API_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(24))")
fi

echo "▶ 设置项目..."
gcloud config set project "$PROJECT_ID"

echo "▶ 开通所需服务（首次会等一会）..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "▶ 构建并部署到 Cloud Run（源码直传，Google 帮你构建镜像）..."
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 60 \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 3 \
  --set-env-vars "API_KEY=$API_KEY"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')

# 保存部署信息（这两样发给我，我来接进操盘台）
cat > DEPLOY_INFO.txt <<EOF
SERVICE_URL=$URL
API_KEY=$API_KEY
EOF

echo ""
echo "✅ 部署完成！"
echo "服务地址: $URL"
echo "自检:     curl \"$URL/health\""
echo ""
echo "📋 部署信息已存到 qlib-service/DEPLOY_INFO.txt"
echo "   请把里面的 SERVICE_URL 和 API_KEY 两行发给我，我来接进操盘台。"
