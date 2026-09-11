# 量化打分微服务

生产服务部署在阿里云函数计算 FC 3.0，与主服务和 OSS 同处
`cn-hangzhou`。当前稳定地址：

```text
https://quant-score-nlxgclpdbu.cn-hangzhou.fcapp.run
```

服务基于 FastAPI、LightGBM 和 GARCH，提供量化评分、走势预测、模型信息与
健康检查。模型优先从部署包加载，并按小时从阿里云 OSS 热更新。

交易决策只由模块化决策引擎产生。36 维 `/predict` 仅提供日线辅助证据；
旧 V2/V3 单体决策入口、独立 EAS 推理和对应训练管线已下线。

独立的 `POST /decision-score` 一次返回选股、建仓、组合、执行、风险和复核
任务头结果。当前生产模型
以 `usagePolicy=DIRECT` 直接用于决策；每日新训练模型必须先与这个现役版本
执行成员级冠军-挑战者评估，不能直接覆盖生产清单。
分布外只提示，不关闭预测。文件、特征合同或预测数值异常仍如实报错，
不影响现有 36 维 `/predict`。

当前机会特征合同为 `opportunity-score-feature.v5`，共 120 维。V5 增加
五日主力/小单连续性及数据可用性字段；旧 V1-V4 请求在量化服务内按版本投影，
新增字段补零，支持主服务与模型的无中断切换。

决策模型训练必须从项目根目录执行以下顺序：

```bash
set -a; . ./.env; set +a
npm run opportunity:export
npm run decision:dataset
npm run decision:bakeoff
npm run decision:train
npm run decision:release
```

少于 1000 个成熟候选、300 个完整成交结果或 60 个独立交易日时，训练只生成
`NOT_READY` 报告。当前组合保存三个固定种子的 LightGBM 成交、胜率、
胜单R、亏单R、Q10 动作价值头，以及三个 CatBoost `YetiRankPairwise`
排序头。每个成员独立校准后在预测层平均，最终仍只输出一组概率、动作价值和
排序分。
排序头在训练端导出为 JSON 对称树，线上由 NumPy 等价执行，不携带 CatBoost
runtime；与原生 CatBoost 的 1,000 条样本对拍最大绝对误差为
`1.67e-16`。
`shadow` 是挑战者产物目录名。每日流水线先下载现役生产包，再对成交概率、
盈利概率、胜负幅度、尾部风险和横截面排序五个组成部分分别评估，并穷举通过
单项门槛的混合组合：

```bash
cd qlib-service
python3 download_decision_release.py \
  --output opportunity-model/champion
python3 -m decision_engine.training.release \
  --dataset opportunity-dataset.npz \
  --champion opportunity-model/champion \
  --challenger opportunity-model/shadow \
  --output opportunity-model/release \
  --decision-output opportunity-model/release_decision.json
```

只有决策为 `PUBLISH` 时才发布选中的完整组合：

```bash
python3 upload_decision_model.py \
  --directory opportunity-model/release \
  --prefix opportunitymodel/ \
  --activate-baseline \
  --release-decision opportunity-model/release_decision.json
```

整体门禁要求净R下置信界大于0，并限制费后净R、最大回撤、命中率、正期望
覆盖率、Brier、净R误差、Q10覆盖率和推理延迟的最大退化。没有可晋级组合时
保持现役 `manifest.json`。发布决策写入
`opportunitymodel/release-history/<version>.json`，模型元数据记录每个头的
来源版本，完整阈值见
`../docs/decisions/ADR-004-v3-selective-model-release.md`。

`.github/workflows/daily-retrain.yml` 在每个工作日北京时间 01:15 自动执行
市场数据归档、成熟样本收集、三折三种子回测、预测级集成训练、成员选择、
整体验证、自动发布和状态归档。回测不会用负期望候选补满 Top5，无机会日期
按 `0R` 保留。生产采样由主 FC 在
10:20、13:40、15:10 运行，17:10 结算。历史加速回填的数据合同见
`../docs/v3-opportunity-history-data.md`。

每日原始市场数据不依赖 Tushare。GitHub Actions 使用仓库 Secret
`QUANT_KEY` 调用杭州量化 FC 的 `POST /archive-market-day`，由 FC 使用
东方财富全市场/历史 5 分钟接口并以腾讯 5 分钟接口兜底，完整性通过后写入
OSS。`daily-retrain.yml` 不读取 `TUSHARE_TOKEN`；Tushare 只保留为人工历史
回填工具。夜间定时任务必须获得最新完整交易日分片，并读回校验 OSS 日线、
资金流、1,000 股分钟池及至少 85% 覆盖率；端点失败、分片缺失或覆盖不足
会直接阻断决策模型训练。盘中手动任务收到 `market_open_skipped` 时可使用已
校验的最近完整分片，不会把未收盘数据写入 OSS。

实时价格与日线优先读取同花顺扶摇，环境变量为 `FUYAO_API_KEY`；东方财富
继续补充换手、行业与资金字段，腾讯作为公开行情兜底。扶摇成交额不会被误作
换手率，业务响应即使 HTTP 为 200 也必须满足 `code == 0`。

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
