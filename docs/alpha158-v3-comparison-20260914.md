# Alpha158、当前 V3 与混合方案对比

日期：2026-09-14

## 结论

- 当前 V3 是三种方案中唯一在 5bps 基准下盈利的方案，收益
  `+0.4229%`，继续作为生产主链。
- Alpha158 Top50/Drop5 在本地样本外区间亏损 `-13.7907%`，不能替换
  当前召回或直接进入生产。
- Alpha158 Top50 与 V3 做硬交集后亏损 `-0.5909%`，只剩 4 笔平仓，
  说明简单过滤主要损失覆盖率，没有提升成交质量。
- 三种方案都没有证明 10%-20% 年度收益或 70% 盈利概率。当前 V3 只是
  相对最优，不等于已经达到稳定盈利目标。

## 部署状态

- 已发布复核模型：`decision-review.1789360354.ensemble3`。
- 量化 FC 已加载该版本，线上状态为 `modelLoaded=true`、
  `productionEligible=true`、`baselineSelected=true`、
  `usagePolicy=DIRECT`。
- 线上 V3 已分别验证策略拒绝和 `READY` 路径，`READY` 返回的价格合同
  哈希与请求一致。
- 主 FC 行情、AI ping 和自定义域名均返回 HTTP 200。
- 本次 Alpha158 代码只用于离线研究，没有改变已部署的生产决策链。

## 实验口径

- 股票池：沪深主板 `000/001/002/003/600/601/603/605`，排除创业板、
  科创板、北交所、ST 和退市股票。
- 原始区间：191 个信号交易日；前 48 日用于初始训练，后 143 日为扩展
  时序样本外预测。
- Alpha158：完整 158 维官方因子顺序，官方 T+1 收盘到 T+2 收盘标签，
  每日使用前一交易日可见流动性选择 1,000 只股票。
- 复权：依据每日 `preClose` 连续调整 OHLC/VWAP，消除除权断点。
- 账户：初始资金 100,000 元，T+1、100 股整手、涨跌停和停牌限制、
  佣金万三且最低 5 元、卖出印花税千分之 0.5、过户费万分之 0.1。
- 基准滑点 5bps，压力滑点 10bps；全部方案复用同一账户撮合与分币审计。

三种方案定义：

1. **Alpha158 排序**：官方式 Top50/Drop5，下一交易日收盘换仓。
2. **当前 V3**：现有 DIRECT 召回、触价观察、V3 复核、账户仲裁和退出。
3. **Alpha158+V3**：仅保留当日 Alpha158 Top50 内的 V3 候选，后续触价、
   拒绝、入场和退出仍由 V3 决定。

## 排序质量

| 区间 | 交易日 | IC | Rank IC | ICIR |
|---|---:|---:|---:|---:|
| Fold 1 | 48 | 0.027621 | 0.016887 | 0.210425 |
| Fold 2 | 48 | 0.042262 | 0.019859 | 0.378280 |
| Fold 3 | 47 | -0.008635 | -0.024759 | -0.053708 |
| 全部样本外 | 143 | 0.020619 | 0.004197 | 0.149888 |

最后一折 IC 和 Rank IC 同时转负，说明 2026 年后段发生明显因子失效。
本地 Rank IC `0.0042` 远低于 CSI500 官方示例的 `0.0482`，不能直接套用
官方年化收益。

## 账户结果

### 5bps 基准

| 方案 | 候选/接受 | 期末权益 | 收益率 | 最大回撤 | 平均资金利用率 | 平仓 | 胜率 | 费用 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Alpha158 Top50/Drop5 | 每日 Top50 | 86,209.26 | -13.7907% | 20.3612% | 39.7991% | 696 | 39.51% | 7,718.86 |
| 当前 V3 | 157 / 88 | 100,422.88 | +0.4229% | 4.1604% | 3.0063% | 45 | 46.67% | 720.33 |
| Alpha158 Top50 + V3 | 157→33 / 12 | 99,409.06 | -0.5909% | 0.8340% | 0.1632% | 4 | 25.00% | 56.65 |

Alpha158 期末仍有 43 个持仓，期末权益已按最后交易日收盘价计价；其胜率
只统计 696 笔已平仓交易。V3 和混合方案期末均为空仓。

### 10bps 压力

| 方案 | 期末权益 | 收益率 | 最大回撤 | 平仓 | 胜率 | 费用 |
|---|---:|---:|---:|---:|---:|---:|
| Alpha158 Top50/Drop5 | 86,306.54 | -13.6935% | 20.0288% | 696 | 38.94% | 7,719.11 |
| 当前 V3 | 99,913.37 | -0.0866% | 4.3532% | 45 | 44.44% | 720.17 |
| Alpha158 Top50 + V3 | 99,376.80 | -0.6232% | 0.8561% | 4 | 25.00% | 56.63 |

Alpha158 的 10bps 结果略好于 5bps，是滑点改变整手数量和期末持仓暴露后的
离散路径结果，不代表更高滑点提高策略收益。

## 原因分析

1. **基准不可直接迁移**：官方示例使用 CSI500、多年样本和亿元账户；本次是
   主板股票、短样本和 10 万元账户，并执行最低佣金、整手和真实资金约束。
2. **本地排序信号弱且失效**：整体 Rank IC 只有 `0.0042`，最后一折为
   `-0.0248`，Top50 已不能稳定提供正向横截面排序。
3. **小账户换手成本过高**：Alpha158 产生 1,435 次成交，费用占初始资金
   `7.72%`；即使加回费用，组合本身仍约亏 `6.1%`。
4. **硬交集错误压缩覆盖**：V3 的 157 个候选只留下 33 个，最终仅完成
   4 笔平仓，平均资金利用率降至 `0.16%`，样本和收益都不足。
5. **当前 V3 边际仍薄**：5bps 仅盈利 `0.42%`，10bps 已转负，尚未形成
   足够厚的交易成本安全垫。

## 生产裁决

- 保持当前 V3 为生产方案，不切换 Alpha158，不上线简单 Top50 交集。
- Alpha158 保持研究用途。下一版混合应把 Alpha158 分数、截面分位和近期
  Rank IC 稳定度作为 V3 联合排序特征，而不是硬召回门槛。
- 联合模型继续以真实机会收益
  `pFill × expectedNetRGivenFill` 为标签，并在训练目标中加入费用、换手和
  资金占用惩罚。
- 只有联合模型在独立选择段和确认段都保持净 R 95% 下界大于 0，并在
  10 万元账户 5/10bps 回放中同时优于当前 V3，才允许替换生产主链。

## 复现产物

- Alpha158 分数：`/tmp/mainboard-alpha158-adjusted-walkforward.json`
- Alpha158 账户：`/tmp/mainboard-alpha158-top50-account-final.json`
- 当前 V3 账户：`/tmp/current-v3-account-repro.json`
- Alpha158+V3 账户：`/tmp/alpha158-v3-account-final.json`

核心命令：

```bash
node --max-old-space-size=6144 backtest/decision/replay-alpha158.mjs \
  --scores /tmp/mainboard-alpha158-adjusted-walkforward.json \
  --daily /Users/bytedance/.v3-year-relabel-work/daily.json.gz \
  --topk 50 --n-drop 5 \
  --output /tmp/mainboard-alpha158-top50-account-final.json

node --max-old-space-size=6144 backtest/decision/replay-review-v3.mjs \
  --selection /tmp/review-v3-selected-outcomes.json \
  --daily /Users/bytedance/.v3-year-relabel-work/daily.json.gz \
  --output /tmp/current-v3-account-repro.json

node --max-old-space-size=6144 backtest/decision/replay-review-v3.mjs \
  --selection /tmp/review-v3-selected-outcomes.json \
  --alpha-scores /tmp/mainboard-alpha158-adjusted-walkforward.json \
  --alpha-top-n 50 \
  --daily /Users/bytedance/.v3-year-relabel-work/daily.json.gz \
  --output /tmp/alpha158-v3-account-final.json
```

## 验证

- Alpha158/V3 定向 Node 测试：4/4 通过。
- Alpha158 Python 测试：4/4 通过。
- 三份账户结果的分币账本审计均为 `ok=true`。
- 全量 Node 测试：2388 项中 2384 通过、4 项失败。其中账号增量同步用例
  单独重跑通过，属于并发时序波动；其余 3 项来自本任务之外的用户文案、
  决策引擎和展示层未提交改动，本任务未修改这些文件。
