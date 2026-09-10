# V3 机会模型历史数据要求

## 当前状态

生产前向账本已经开始积累。2026-09-09 首次修复结算后得到：

- 157 个成熟候选
- 30 个完整成交结果
- 4 个独立交易日

2026-09-10 完成 Free-StockDB 因果历史回放后，训练基线更新为：

- 38,862 个历史成熟候选，另有 1 条未成熟路径被排除；
- 与 157 条线上结果合并后共 39,019 个成熟候选；
- 22,010 个完整成交结果；
- 69 个独立交易日，其中历史信号日为 65 日；
- 所有历史样本均使用 `opportunity-score-feature.v3`。

同日使用 Tushare `stk_mins` 完成更长窗口复核后，训练基线进一步更新为：

- 2026-03-10 至 2026-08-31 共 120 个历史信号日；
- 5,208 只去重股票、13,354,992 根合格 5 分钟线；
- 126 个回放/结算日的最低完整代码覆盖率为 99.6075%；
- 19 个停牌零值占位“股票-日”被整日排除，没有填充虚假价格；
- 72,847 个历史成熟候选，另有 1 条未成熟路径被排除；
- 与线上结果合并后共 73,004 个成熟候选、37,516 个完整成交结果、
  124 个独立交易日。

生产晋级最低要求为 1000 个成熟候选、300 个完整成交结果和 60 个独立
交易日。数量达到只代表可以训练，模型还必须通过独立时间窗、Top5 费后净R
下界、相对旧公式提升、回撤和命中率闸门。

## 立即回填的最小范围

- 时间：至少 60 个完整交易日，建议 80 至 120 个交易日。
- 股票：至少 800 只同期高流动性 A 股，优先全市场；不得只提供上涨股票。
- 时点：每个交易日按 10:20、13:40、15:10 三个截面重放。
- 时区：所有时间使用 `Asia/Shanghai`，精确到分钟。
- 价格：执行结算必须使用不复权原始价格；技术特征可另给前复权序列。
- 退市、ST、停牌、涨跌停和上市状态必须按当日状态提供。

按 800 只股票、60 个交易日、每天三个截面回放，可以先生成全市场候选，
再按生产四路召回和稳定探索规则抽样。禁止提前用未来收益筛选股票。

## 必需数据

### 1. 个股 5 分钟行情

每行至少包含：

```text
ts_code,trade_time,open,close,high,low,vol,amount
```

要求：

- 包含信号日前至少 20 个交易日，以及信号后至少 5 个交易日。
- 09:35 至 15:00 的交易时点完整，午间无虚假 bar。
- 原始价用于成交、滑点、涨跌停、T+1、止损和止盈路径结算。
- 同一代码、同一时间只能有一条记录。

项目现有 `qlib-service/minute_data.py` 可直接校验 Tushare `stk_mins`
字段并保存为月度 NPZ 缓存。

### 2. 个股日线与当日截面

每个代码、交易日至少包含：

```text
trade_date,ts_code,open,high,low,close,pre_close,vol,amount,
turnover_rate,volume_ratio,limit_up,limit_down
```

盘中截面还需保留截至 10:20 或 13:40 已发生的：

```text
price,high_so_far,low_so_far,amount_so_far,volume_so_far,vwap
```

日线用于 2/5 日收益、ATR、支撑压力和近 5 日涨停拥挤度。盘中截面不得使用
收盘后才知道的全天最高、最低、成交额或换手率。

### 3. 个股资金流

至少提供：

```text
trade_date,ts_code,available_at,main_net_amount,retail_net_amount
```

`available_at` 是该记录第一次可被策略读取的时间。若数据源只有盘后资金流，
盘中历史回放必须严格滞后到下一交易日，不能回填为当日 10:20 或 13:40
已知数据。

### 4. 市场与板块时点数据

至少提供：

```text
trade_date,as_of,index_code,index_change_pct,up_count,down_count,
limit_up_count,limit_down_count,broken_limit_count
```

以及：

```text
trade_date,as_of,sector_code,sector_name,change_pct,rank,
net_amount,member_code,effective_from,effective_to
```

板块成员关系必须是历史时点版本。使用今天的行业或概念成分回填过去会造成
生存者偏差，数据将被拒绝。

### 5. 交易状态和公司行动

至少提供：

```text
trade_date,ts_code,is_st,is_suspended,list_date,delist_date,
adjust_factor,limit_rule
```

执行结算保留原始价格；技术序列如需前复权，必须使用信号时点可获得的复权
因子，且保留原始价和复权价之间的映射。

## 可选但有价值的数据

- 公告：`published_at`、标题、类型、原始链接、股票代码。
- 机构调研：首次披露时间、参与机构数、原文链接。
- 供应链关系：关系类型、生效时间、来源和失效时间。
- 集合竞价：09:26 后可见的价格、成交量、成交额、换手和量比。

这些数据只用于催化与打法解释。没有可追溯发布时间的新闻摘要不能作为历史
特征，也不能提升仓位。

## 可接受交付

优先级如下：

1. Tushare Pro 可调用权限，包含 `stk_mins`、日线、每日指标、资金流、
   交易日历和股票状态。
2. Parquet/CSV 文件，按上述字段提供，并附数据字典和复权说明。
3. 已整理的分钟 NPZ 缓存，必须通过 `minute_data.py` 的完整性校验。

不要提供：

- 只包含成功案例或当前热门股票的数据。
- 没有明确时区、复权方式或可见时间的数据。
- 用未来板块成分、未来公告更正或收盘数据填充盘中截面的数据。
- 只有旧 36 维特征和涨跌标签的数据。该数据缺少成交路径和费后净R，
  不能伪装为 V3 样本。

## StockDB 一次性回填

用户确认 Free-StockDB v0.3.5 数据由其本人记录、验证并仅供本人使用。项目
通过本机 `127.0.0.1:7899` 只读接口接入，不调用公共体验 MCP，也不开放
StockDB 到局域网或公网。

执行入口：

```bash
npm run opportunity:backfill-stockdb -- \
  --stockdb-root "$HOME/.stockdb-v0.3.5-run" \
  --work-dir "$HOME/.stockdb-v3-work" \
  --from 20251114 \
  --to 20260731 \
  --signal-days 65 \
  --universe-size 1000
```

回填严格采用历史时点口径：

- 每日股票池只读取前一交易日数据，保留 80% 高流动性股票和 20% 稳定探索
  样本，不使用未来涨幅筛选；
- 10:20、13:40 的价格、最高、最低、成交量、成交额、VWAP、换手和量比仅由
  截止当时的一分钟行情累计；
- 当日盘后资金只用于 15:10 收盘截面，盘中截面仅能读取此前交易日资金；
- 当前板块成员不回填历史板块特征；缺失项保留为未知，由后续真实前向样本
  逐步补齐；
- 现价、回踩、突破路径均使用生产结算器计算 T+1、手续费、滑点、止损、止盈
  和时间退出。

成熟回放结果会压缩并以内容摘要版本化保存到
`opportunitymodel/training-data/`。每日 V3 重训自动合并该历史基线和线上
真实结果，同一 `decisionId` 由真实线上结果覆盖。StockDB 原始数据、分钟
中间文件、本地训练集和本地模型在发布验收后全部删除。

本次回放实际使用 2026-04-17 至 2026-07-22 的 65 个信号日，并用后续 6 个
交易日完成路径结算。历史基线已发布为：

```text
opportunitymodel/training-data/runs/
  1788973698511-a9788fcba99740cf.json.gz
```

压缩对象大小为 7,277,234 字节，下载后 SHA-256 与 manifest 一致。

本轮 LightGBM 训练结果为 `REJECTED`，没有发布 shadow 或 production 模型：

- Top5 平均费后净R：新模型 0.745636，旧公式 0.486273；
- Top5 最大回撤：新模型 0.5122R，旧公式 1.378R；
- Top5 正净R命中率：新模型 21.8182%，旧公式 23.6364%；
- Top5 净R下置信界：-0.273382R；
- 3 个 walk-forward 窗口均未稳定通过胜率/净R基线闸门。

因此线上状态保持 `productionEligible=false` 和 `MODEL_NOT_READY`。历史基线
会继续与后续真实前向样本合并训练，禁止因样本数量达标而绕过效果闸门。

## Tushare 完整回填

批量任务使用项目内置 HTTP 客户端，不经 MCP；Token 只从进程环境变量读取。
网关限制为 150 次/分钟，回填器最多允许 120 次/分钟，默认 90 次/分钟，并
共享 429 冷却。

执行入口：

```bash
export TUSHARE_TOKEN="..."
npm run opportunity:backfill-tushare -- \
  --work-dir "$HOME/.tushare-v3-work" \
  --from 20251101 \
  --to 20260909 \
  --signal-days 120 \
  --universe-size 1000 \
  --max-per-min 120
```

日线 `vol` 从手转换为股，`amount` 从千元转换为元；资金流按 Tushare
大单+特大单及小单买卖额分别计算主力和散户代理净额。分钟价格先消除
IEEE-754 序列化噪声，再执行严格 OHLC 校验。仅当成交量、成交额均为 0 且
至少一个 OHLC 非正时，整交易日按停牌占位排除。

本轮训练仍为 `REJECTED`，没有发布 shadow 或 production 模型：

- 独立 holdout：2026-08-11 至 2026-09-08；
- V3 Top5 平均费后净R为 -0.213379R，旧公式为 -0.664453R；
- V3 Top5 最大回撤为 4.8656R，旧公式为 12.2156R；
- V3 Top5 正净R命中率为 24.2105%，旧公式为 7.3684%；
- V3 Top5 净R下置信界为 -0.518984R；
- `pWinGivenFill` LogLoss、`expectedNetR` MAE 和 walk-forward 稳定性未过闸。

历史基线已发布到 `opportunitymodel/training-data/`，训练状态已发布为
`REJECTED`。数量门槛已满足，但最近窗口仍是负期望，禁止以“完整重训练”为由
强行晋级。

参考：

- Tushare 代理接入与限频：https://ts.gyzcloud.top/docs
- 官方分钟接口：https://tushare.pro/document/2?doc_id=370
- 官方日线接口：https://tushare.pro/document/2?doc_id=27
- 官方资金流接口：https://tushare.pro/document/2?doc_id=170

## 上线判定

历史回填完成后仍按同一自动流程：

```text
数据校验
→ 按历史时点重放全市场扫描
→ 三路径成交与退出结算
→ V3数据集
→ walk-forward训练和校准
→ shadow隔离发布
→ 生产晋级检查
→ 仅全部通过后更新production manifest
```

通过生产闸门后，V3 才能为 `ATTACK` 档提供标准仓位；未通过时最多只能进入
小仓验证。现有 36 维量化模型仍可独立参与当下决策，但同样必须通过价格、
现金、T+1、费后正期望和账户风险检查。
