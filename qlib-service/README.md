# 量化打分微服务 → 部署到 Google Cloud Run

一个轻量的 A 股量化打分接口（Qlib/Alpha158 因子思路）：输入 6 位股票代码，
返回 **0~100 综合分 + 偏多/偏空/中性 + 做T方向建议 + 可解释因子**。
数据用 AKShare（东财，免费），CPU 秒级推理，无需预训练下载。

## 原子模型发布

生产模型不再直接覆盖一组固定文件。`upload_model.py` 会先把模型、元数据、
信号头和事件标签写入 `quantmodel/runs/<run-id>/`，逐文件记录 SHA-256，
全部成功后最后更新 `quantmodel/manifest.json`。推理进程只加载同一 manifest
引用且校验值一致的整套产物；manifest 缺失时才兼容读取旧固定路径。

## 统一策略组合回测

`strategy_portfolio_backtest.py` 直接读取线上
`strategy-spec.v1`，输出 `strategy-backtest.v1` 报告：

```bash
python3 strategy_portfolio_backtest.py \
  --strategy "https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run/api/strategy_specs?strategyId=market-quant-resonance" \
  --bars ./research/strategy-bars.json \
  --out ./research/strategy-report.json \
  --initial-cash 1000000
```

`strategy-bars.json` 可直接是数组，也可使用 `{"bars":[]}`。每条记录必须包含：

- `date`、`code`：`YYYYMMDD`、`600519.SH` 格式。
- `open/high/low/close/previousClose/volume`：未复权日线，`volume` 单位为股。
- `marketScore/pct/volRatio/quant`：当日收盘时已可获得的策略证据，禁止写入未来数据。

撮合顺序固定为：当日收盘产生信号 → 下一交易日开盘买入；收盘触发止损、止盈或到期 → 下一交易日开盘卖出。回测包含整手买入、T+1、停牌、涨跌停拒单、滑点、佣金、印花税、过户费、现金与最大持仓约束。报告保留交易、拒单、每日权益和未平仓头寸，不会在样本末尾虚构强制成交。

## Point-in-time 数据集与 Walk-forward

`strategy_research_dataset.py` 将样本外预测和历史面板连接成
`strategy-dataset.v1`。执行回测只接受 `price_adjustment=RAW` 的未复权
OHLCV，拒绝 QFQ/未知口径；Tushare `daily.vol` 必须声明
`volume_unit=HANDS`，构建时会转换为股。预测文件中的 `actual` 等未来标签
不会写入策略记录。

未复权面板可用可恢复采集器生成。每只股票原子写入独立 NPZ；相同请求区间
重跑时会跳过完整文件，网络中断后可直接续跑：

```bash
set -a; . ../.env; set +a
python3 collect_strategy_raw_panel.py \
  --predictions ./research/holdout_predictions.npz \
  --start 20251001 \
  --end 20260731 \
  --out /tmp/strategy-raw-panel \
  --max-per-minute 135
```

```bash
python3 strategy_research_dataset.py \
  --panel /tmp/strategy-raw-panel \
  --predictions ./research/holdout_predictions.npz \
  --score-key ensemble_prediction \
  --source-id oos:model-version \
  --out /tmp/strategy-dataset.json.gz \
  --minimum-history 20 \
  --minimum-coverage 0.95
```

质量清单记录覆盖率、未匹配预测、被拒绝的已匹配行、缺失字段、未来字段和
每类证据来源。只有 `quality.usable=true` 的数据集能进入
`strategy_walk_forward.py`：

```bash
python3 strategy_walk_forward.py \
  --strategy ./research/strategy-spec.json \
  --dataset /tmp/strategy-dataset.json.gz \
  --out /tmp/strategy-walk-forward.json \
  --minimum-train-days 60 \
  --purge-days 5 \
  --test-days 20 \
  --step-days 20 \
  --initial-cash 1000000
```

Walk-forward 使用扩展训练窗口、purge gap 和互不重叠的测试窗口。策略版本
全程冻结，不在训练段调参；每个 fold 重置本金，汇总收益只来自测试段。小股票池
pilot 只能验证数据与执行链路，不能代替完整股票池的晋级结论。

需要比较少量预注册候选时，先生成固定候选目录和完整指数基准，再运行嵌套
Walk-forward。外层测试窗口不会参与候选选择：

```bash
python3 strategy_candidate_catalog.py \
  --strategy ./research/strategy-spec.json \
  --out /tmp/strategy-candidates.json

python3 collect_strategy_benchmarks.py \
  --predictions ./research/holdout_predictions.npz \
  --out /tmp/strategy-benchmarks.json

python3 strategy_nested_walk_forward.py \
  --candidates /tmp/strategy-candidates.json \
  --dataset /tmp/strategy-dataset.json.gz \
  --benchmarks /tmp/strategy-benchmarks.json \
  --out /tmp/strategy-nested-report.json
```

## 一、Cloud Run 适合吗？

适合，而且是这几个方案里最优的：
- **按请求计费、闲时缩容到 0**：不调用时几乎不花钱
- **新账号 $300 / 90 天额度**：这点用量基本免费
- **原生跑容器**：不像 HF 免费版处处设限

## 二、你要做的操作（约 15 分钟，只做一次）

### 1. 装 gcloud CLI 并登录
- 官网装 Google Cloud CLI：https://cloud.google.com/sdk/docs/install
- 然后在终端：
  ```bash
  gcloud auth login          # 浏览器登录你的 Google 账号
  ```

### 2. 建一个 GCP 项目 + 开通结算
- 打开 https://console.cloud.google.com
- 顶部「选择项目」→「新建项目」，记下 **项目 ID**（形如 `my-quant-123456`）
- 左侧菜单「结算 Billing」→ 绑定一张卡（新账号送 $300，不会立刻扣费）

### 3. 一键部署
在本目录（`qlib-service/`）下：
```bash
# ① 编辑 deploy.sh，把 PROJECT_ID 改成你上一步的项目 ID
# ② 运行
bash deploy.sh
```
脚本会自动：开通所需服务 → 源码直传让 Google 构建镜像 → 部署到 Cloud Run（台湾节点）→
生成一把 API 密钥 → 把「服务地址 + 密钥」写进 `DEPLOY_INFO.txt`。

### 4. 把两样东西发我
部署成功后，打开 `qlib-service/DEPLOY_INFO.txt`，把里面这两行发我：
```
SERVICE_URL=https://quant-score-xxxxx.a.run.app
API_KEY=xxxxxxxx
```
我来把它接进操盘台（改 `api/ai.js` 调用它，在 Vercel 配好环境变量并重新部署）。

## 三、部署后自检（可选）
```bash
# 健康检查（应返回 {"ok":true,...}）
curl "https://你的服务地址/health"

# 打分测试（茅台）——注意带 X-API-Key
curl -H "X-API-Key: 你的密钥" "https://你的服务地址/score?code=600519"
```

## 四、费用 & 安全
- **费用**：min-instances=0，闲时不计费；单次打分算力极小，正常个人使用远在免费额度内。
- **安全**：接口用 `X-API-Key` 校验，只有你的操盘台（配了同一把密钥）能调用，防盗刷。
- **随时下线**：`gcloud run services delete quant-score --region asia-east1` 即可删除，不留费用。

## 文件说明
| 文件 | 作用 |
|---|---|
| `app.py` | FastAPI 服务：`/score` 打分接口 + `/health` 健康检查 |
| `requirements.txt` | Python 依赖 |
| `Dockerfile` | 容器构建（Cloud Run 用） |
| `deploy.sh` | 一键部署脚本 |
