# 量化打分微服务 → 部署到 Google Cloud Run

一个轻量的 A 股量化打分接口（Qlib/Alpha158 因子思路）：输入 6 位股票代码，
返回 **0~100 综合分 + 偏多/偏空/中性 + 做T方向建议 + 可解释因子**。
数据用 AKShare（东财，免费），CPU 秒级推理，无需预训练下载。

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
