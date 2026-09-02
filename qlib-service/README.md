# 量化打分微服务

生产服务部署在阿里云函数计算 FC 3.0，与主服务和 OSS 同处
`cn-hangzhou`。当前稳定地址：

```text
https://quant-score-nlxgclpdbu.cn-hangzhou.fcapp.run
```

服务基于 FastAPI、LightGBM 和 GARCH，提供量化评分、走势预测、模型信息与
健康检查。模型优先从部署包加载，并按小时从阿里云 OSS 热更新。

独立的 `POST /opportunity-score` 只承载机会雷达影子评分。没有通过
时间外验证并发布到 `opportunitymodel/manifest.json` 的模型时，接口稳定返回
`NOT_READY` 和空概率，不影响现有 36 维 `/predict`。

机会模型训练必须从项目根目录执行以下顺序：

```bash
set -a; . ./.env; set +a
npm run opportunity:export
npm run opportunity:dataset
npm run opportunity:train
```

少于 1000 个成熟候选、300 个完整成交结果或 60 个独立交易日时，训练只生成
`NOT_READY` 报告。通过影子闸门后仍需显式发布，禁止训练脚本自动覆盖线上模型：

```bash
cd qlib-service
python3 upload_opportunity_model.py \
  --directory opportunity-model/shadow
```

## 生产架构

- 计算：阿里云 FC 3.0 `quant-score`
- 存储：阿里云 OSS `quantmodel/`、`sectormodel/`
- 部署描述：`s.yaml`
- 运行包：`deploy_pkg/`
- 主服务接入：`QUANT_URL`、`QUANT_KEY`

腾讯财经接口仅作为公开行情数据源，不承载计算、存储或定时任务。

## 部署

在项目根目录准备 `.env`，然后执行：

```bash
cd qlib-service
bash deploy.sh
```

`deploy.sh` 会：

1. 检查并同步 `deploy_pkg/` 中的源码、模型和启动脚本。
2. 在缺少 vendored Python 依赖时调用 `build_deploy_pkg.sh`。
3. 加载项目根目录 `.env`。
4. 通过 Serverless Devs 部署到阿里云 FC。
5. 调用 `/health` 完成部署后验证。

修改依赖或首次构建时，也可以显式执行：

```bash
cd qlib-service
bash build_deploy_pkg.sh
set -a
. ../.env
set +a
npx @serverless-devs/s deploy -y
```

## 验收

```bash
curl -s \
  https://quant-score-nlxgclpdbu.cn-hangzhou.fcapp.run/health

curl -s \
  -H "X-API-Key: $QUANT_KEY" \
  https://quant-score-nlxgclpdbu.cn-hangzhou.fcapp.run/model_info
```

`/health` 应返回 `ok: true`；`/model_info` 应返回 `loaded: true`。

## 模型发布

`upload_model.py` 会先将模型、元数据、信号头和事件标签写入
`quantmodel/runs/<run-id>/`，逐文件记录 SHA-256，全部成功后再原子更新
`quantmodel/manifest.json`。

推理进程只加载同一 manifest 引用且校验值一致的整套产物。manifest 缺失时
兼容读取旧固定路径；OSS 暂时不可用时继续使用部署包内的 bundled 模型。

## 文件说明

| 文件 | 作用 |
|---|---|
| `app.py` | FastAPI 服务入口 |
| `factors_lib.py` | 训练与推理共用的 36 维因子口径 |
| `model_lib.py` | 模型加载、OSS 热更新和 GARCH |
| `s.yaml` | 阿里云 FC 3.0 部署描述 |
| `bootstrap` | FC 自定义运行时启动脚本 |
| `build_deploy_pkg.sh` | 构建免 Docker 的 FC 运行包 |
| `deploy.sh` | 阿里云 FC 一键部署入口 |
| `Dockerfile` | 阿里云容器部署备用方案 |
