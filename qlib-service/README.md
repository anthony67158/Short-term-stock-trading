# 量化打分微服务

生产服务部署在阿里云函数计算 FC 3.0，与主服务和 OSS 同处
`cn-hangzhou`。当前稳定地址：

```text
https://quant-score-nlxgclpdbu.cn-hangzhou.fcapp.run
```

服务基于 FastAPI、LightGBM 和 GARCH，提供量化评分、走势预测、模型信息与
健康检查。模型优先从部署包加载，并按小时从阿里云 OSS 热更新。

独立的 `POST /opportunity-score` 承载机会动作价值评分。按用户要求，当前模型
以 `usagePolicy=DIRECT` 直接用于决策，不以影子资格或晋级结果为前提。
分布外只提示，不关闭预测。文件、特征合同或预测数值异常仍如实报错，
不影响现有 36 维 `/predict`。

机会模型训练必须从项目根目录执行以下顺序：

```bash
set -a; . ./.env; set +a
npm run opportunity:export
npm run opportunity:dataset
npm run opportunity:train
```

少于 1000 个成熟候选、300 个完整成交结果或 60 个独立交易日时，训练只生成
`NOT_READY` 报告。当前组合保存 LightGBM 的成交、胜率、胜单R、亏单R、Q10
五个动作价值头，以及一个 CatBoost `YetiRankPairwise` 排序头。
排序头在训练端导出为 JSON 对称树，线上由 NumPy 等价执行，不携带 CatBoost
runtime；与原生 CatBoost 的 1,000 条样本对拍最大绝对误差为
`1.67e-16`。
`shadow` 是兼容保留的产物目录名，不代表仅允许影子使用。直接发布当前模型：

```bash
cd qlib-service
python3 upload_opportunity_model.py \
  --directory opportunity-model/shadow \
  --prefix opportunitymodel/ \
  --activate-baseline
```

walk-forward、Top5 费后净R提升、下置信界、回撤和命中率仍保留为晋级诊断，
不阻止当前模型使用。可选的晋级记录生成：

```bash
cd ..
npm run opportunity:promote
cd qlib-service
python3 upload_opportunity_model.py \
  --directory opportunity-model/production \
  --prefix opportunitymodel/
```

`shadowOnly`、`productionEligible` 保留真实评测记录，不需要人为改成通过。
模型启用由 `usagePolicy=DIRECT` 明确表达；不得伪造评测成功。

`.github/workflows/daily-retrain.yml` 在每个工作日北京时间 01:15 自动执行
成熟样本收集、三折三种子回测、V3组合训练、当前基准直接发布、资格诊断和状态
发布。资格检查未全部通过不会伪造 `productionEligible`，也不会撤销用户指定
的当前 `DIRECT` 基准。生产采样由主 FC 在
10:20、13:40、15:10 运行，17:10 结算。历史加速回填的数据合同见
`../docs/v3-opportunity-history-data.md`。

每日原始市场数据不依赖 Tushare。GitHub Actions 调用杭州量化 FC 的
`POST /archive-market-day`，由 FC 使用东方财富全市场/历史 5 分钟接口并以
腾讯 5 分钟接口兜底，完整性通过后写入 OSS。Tushare 只保留为短期回填和
行业成员刷新工具。

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
