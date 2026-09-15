# A股短线人工执行系统盈利能力改进研究

日期：2026-09-15

范围：只研究在**不提高单笔仓位、总仓位或账户风险预算**的前提下，如何提高费后盈利能力。结论优先依据本地审计、仓库代码、原始论文、官方项目文档和交易所规则。

## 结论

当前第一问题不是模型复杂度或交易覆盖，而是**尚无合格盈利基线，且 V4 数据合同和原始机会标签不支持正期望结论**：

1. `/tmp/current-v3-account-repro.json` 的 `maximumOpenRiskPct=14.5173`，超过 BASELINE 上限 `5%`；`maximumSinglePositionPct=20.7401`，超过单票上限 `20%`；同时缺少 `riskProfileVersion`，10bps 压力收益转负。`profitability-v2` 因此返回 `BASELINE_REJECTED`。[验证器](../backtest/decision/run-profitability-v2.mjs#L184-L330) 191 日回放的 `+0.4229%` 只能作为诊断结果，不能作为权威盈利基线。
2. 15 年 V4 本地审计的 882,912 个事件、176 维特征中有 53 维恒定；review VWAP 全缺，`initialPFill`、`initialPWinGivenFill`、`initialExpectedNetR` 全缺，sector context/action 与 formula ID 全为 `UNKNOWN`。Alpha 覆盖虽为 `87.2219%`，但无法补偿这些业务特征块缺失。
3. 原始费后机会均值在各打法和路径上全部为负：较好的 `MOMENTUM_BREAKOUT=-0.053R`、`IMMEDIATE=-0.091R`，`PULLBACK=-0.375R`、`BREAKOUT=-0.276R`；Alpha 分位有单调性，但 Top10% 仍为 `-0.132R`。这首先指向候选生成、标签与执行口径，而不是阈值或校准器。
4. position 模型的 103,982 个样本覆盖 807 日，Alpha 覆盖仅 `21.2%`，`sellableRatio` 恒为 `1`；确认段 `EXIT=91.9%`，平均效用 `-0.00390R`，相对现役 adapter `-0.00397R`，95% 下界 `-0.00636R`，不具备发布资格。[数据报告](../qlib-service/position-model/research-current/dataset-report.json) [训练报告](../qlib-service/position-model/research-current/position_training_report.json)

因此优先级应为：

**合格基线与数据合同 > 候选/标签正期望 > 执行真实性 > 时间外验证 > 校准与排序 > 组合去相关与状态稳健性 > position 重训。**

## 本地证据边界

| 对象 | 已验证事实 | 研究含义 |
|---|---|---|
| current-v3 191 日回放 | `BASELINE_REJECTED`；开放风险 `14.5173%`、单票 `20.7401%`、缺风险合同版本、10bps 转负 | 可继续作为生产失败关闭对象，不能称为 profitability-qualified baseline |
| V4 review 数据 | 882,912 事件、398,721 条条件样本、2,532 个交易日、176 维；53 维恒定 | 在修复数据合同前，复杂 ranker 和分层校准的收益不可归因 |
| 原始机会标签 | 所有已审计打法、路径和 Alpha Top10% 均为负费后均值 | 必须先让预注册可交易桶出现正均值与正下界 |
| V4 发布结果 | 确认段年化成交 `126.66`，但 10bps 净 R 下界 `-0.02749R`、最大回撤 `11.72%` | 交易数达到目标不等于盈利能力合格。[V4 复盘](./v4-review-15y-training-20260915.md) |
| position 模型 | Alpha 低覆盖、T+1 可卖比例恒定、确认段效用和相对 adapter 均为负 | 保持关闭，先重建真实持仓状态和动作标签 |

## 优先建议

### P0-0：先建立合格基线并修复数据合同

**依据。** 当前验证器要求风险合同一致、风险证据完整、5bps/10bps/下一开盘情景有效，且压力情景不能消除优势；当前 V3 明确未满足。[本地任务记录](./trading-engine-profitability-v2-tasks.md#L291-L304)

**系统映射。**

- 冻结账户、事件、价格、费用、退出、风险和最终确认版本，重新生成同一合同的 current-v3 三情景回放。生产冠军与盈利合格基线必须分开标记。
- 在 `scripts/build_v4_review_dataset.py` 的训练前审计中阻断恒定或全缺的 DIRECT 业务特征。重点恢复 review VWAP、initial 三个价值字段、sector context/action 和 formula ID；无法可靠回填的字段从 DIRECT 合同删除，不能靠缺失掩码伪装为有效信号。
- 每个 train/calibration/selection/confirmation 分段都输出覆盖率、唯一值数、时间范围和数据哈希。

**验收。**

- 基线必须返回 `BASELINE_QUALIFIED`：存在正确 `riskProfileVersion`，`maximumOpenRiskPct<=5%`，`maximumSinglePositionPct<=20%`，账本审计通过，5bps、10bps和下一开盘压力均为正。
- DIRECT 的必需连续字段覆盖率均 `>=95%`；必需枚举的 `UNKNOWN` 比例均 `<=5%`。全量数据中非缺失指示器特征不得恒定；不适用字段必须从 schema 显式删除。
- 在此门禁通过前，任何模型只能报告绝对诊断结果，不得宣称“相对 V3 提升”。

### P0-1：先修候选与费后标签，再优化模型

**依据。** 最优执行应把收益、交易成本和执行风险放在同一目标中，而不是只扩大成交数量。[S1] Qlib 官方回测也将开平仓费用、最低费用和涨跌停可交易性纳入评估。[S2] 当前 `cost_aware_opportunity_reward` 的额外换手、资金占用和尾损参数默认均为零，[代码](../qlib-service/decision_engine/training/opportunity_reward.py#L90-L132)；V4 选策则先比较 `annualizedTrades`，再看净 R 下界。[代码](../qlib-service/decision_engine/training/review_ensemble.py#L688-L710)

**系统映射。**

- 从全市场多打法召回、路径生成、触发和退出逐层审计负期望来源，不用 Alpha Top10% 或旧公式先过滤。Alpha158 保持连续特征。
- 条件头只在成交样本学习 `E[netR|fill]`；无条件 ranker 标签定义为“成交后的费后净 R，未成交为 0R”，已包含成交概率，不得再乘一次 `pFill`。
- 策略选择先约束 `stress10NetRLowerBound95>0`，再比较平均净 R、回撤与覆盖；年化 `80-160` 笔只作可行域。

**验收。**

- 至少一个预注册的打法和路径桶在最终时间 OOS 中同时满足：有效成交 `>=200`、10bps 费后均值 `>0`、stationary block bootstrap 95% 下界 `>0`。
- Alpha Top10% 的 10bps 费后均值和下界均 `>0`；只有分位单调但绝对值为负仍判失败。
- Top5 组合的 10bps 净 R 下界 `>0`、最大回撤 `<=10%`；禁止以增加交易数补入负期望候选。

### P0-2：建模人工执行、部分成交和滑点

**依据。** 沪深交易所采用价格优先、时间优先撮合，主板买入为 100 股整数倍，并受涨跌停和 T+1 约束；K 线触价不等于排队订单成交。[S4][S5] 执行研究要求联合考虑成交率、滑点、费用和市场冲击。[S1][S16]

**系统映射。**

- 当前 `opportunityOutcomeResolver.js` 以触发后的下一根 bar 和固定滑点近似整笔成交；改为 `FULL/PARTIAL/UNFILLED`、time-to-fill、fill ratio 和条件滑点。
- 使用 `executionAttribution.js` 已记录的 `fillRatePct`、`executionSlippageBps`、`vwapDeviationBps`、费用和 `recordDelayMs`，让未执行和部分成交也进入执行模型。
- 无 Level-2 时采用悲观成交规则；涨停买入、跌停卖出、停牌、同 bar 路径歧义和 T+1 锁定单独处理。固定 5/10/20bps 只保留为压力情景。

**验收。**

- 终态执行意图覆盖率 `>=95%`；回放通过 100 股、涨跌停、T+1、部分成交和无同 bar 未来信息测试。
- `pFill` 的时间 OOS Brier skill `>0`；样本数 `>=100` 的可靠性桶误差 `<=5` 个百分点。
- 条件滑点 MAE 优于固定 5bps，实际滑点落入预测 P90 的比例为 `88%-92%`。

### P0-3：使用嵌套 purged walk-forward 和真实块置信区间

**依据。** 跨期金融标签需要 purge 与 embargo，多模型共用选择窗还会产生多重试验偏差。[S12][S14][S15] 相关时间序列应按连续块重采样。[S13] 当前 `block_bootstrap_lower_bound()` 实际对每日值 i.i.d. 抽样。[代码](../qlib-service/decision_engine/training/evaluation.py#L310-L330)

**系统映射。**

- 保留现有标签区间和事件组 purge；外层至少 5 个前推 OOS 窗，内层只做训练、校准和策略选择。
- embargo 取 `max(5个交易日, 最大标签/观察窗口)`；最后 252 个交易日只做一次最终确认。
- 用 moving block 或 stationary bootstrap 替换逐日独立抽样，并记录全部模型、特征和阈值试验，报告 SPA 或 DSR。

**验收。**

- 每折 `label interval overlap=0`、`event group overlap=0`，数据与切分哈希固定。
- 至少 5 个外层窗中 4 个 10bps 费后均值为正，聚合块 bootstrap 95% 下界 `>0`。
- 只有在存在同合同的 `BASELINE_QUALIFIED` 基线时，才要求配对 SPA `p<0.05` 或 DSR `>=0.95`；最终确认失败后不得继续调参。

### P1-4：在字段完整后做概率校准

**依据。** 树模型可保持排序能力但概率失真；sigmoid/isotonic 应在独立时间外数据上选择。[S6][S7] Brier 同时包含可靠性、区分度和不可约不确定性，不能单独代表校准。

**系统映射与验收。**

- 保持 `pFill`、`pWinGivenFill` 和 `P(fill and netR>0)` 分离；按路径、打法、时段和事前市场状态做层级收缩，小样本桶回退全局。
- initial 三个价值字段覆盖未达到 P0-0 前不做分层校准。
- 每个外层 OOS 窗的 Brier 与 log loss 不劣于未校准模型；整体 Brier skill `>0`、加权 ECE `<=0.03`、高概率桶过度自信 `<=5pp`。

### P1-5：按真实决策批次做横截面排序

**依据。** Learning-to-rank 必须在同一 query/group 内比较；LightGBM 与 CatBoost 的官方接口均要求显式分组。[S8][S17][S18]

**系统映射与验收。**

- 当前 ranker 的 `qid` 只有交易日；改为 `tradeDate + mode + decisionBatch/checkpoint`。ranker 只在 P0-1 已证明绝对正期望的合法候选中排序。
- 标签使用无条件 10bps 费后机会价值；排序头只决定同批优先级，概率和价值头决定是否可交易。
- 时间 OOS 的 NDCG@5、RankIC、Top5 平均净 R 和净 R 下界均不得下降；Top5 10bps 下界仍须绝对 `>0`。

### P1-6：把去相关约束接入生产组合

**依据。** 组合选择应考虑协方差；Ledoit-Wolf 收缩可降低有限样本估计误差，而复杂优化在样本外未必优于保守分散。[S9][S10][S11]

**系统映射与验收。**

- 将目前只用于离线回放的 `portfolioCorrelationSelection.js` 接到生产联合排序后、手数计算前；使用决策时可见的 20/60 日指数与板块残差收益。
- 缺失或常数收益序列标为 `UNKNOWN` 并限制新增相关风险，不能按低相关自动接受。
- 同候选、同手数、同风险下，最大回撤相对无去相关方案下降 `>=10%`，10bps 收益下降不超过 `1` 个百分点，净 R 下界不得下降；有效相关性覆盖 `>=95%`。

### P1-7：按市场状态验证稳健性，不做弱市一票否决

**依据。** 跨市场环境的不变特征学习可改善分布漂移下的预测和回测稳健性。[S19]

**系统映射与验收。**

- 用决策时可见的指数趋势、波动、宽度、流动性和板块扩散预定义状态，作为特征、重加权或回退依据，不恢复全局禁止。
- 每个样本充足状态至少有 `100` 个实际成交，10bps 平均净 R 均 `>=0`；不足时标记 `INCONCLUSIVE`。
- 最大回撤 `<=10%`，跨年度至少 `70%` 年份为正；线上特征或校准漂移越界时回退现役模型，不扩大仓位。

### P1-8：重建独立退出与持仓动作头

**依据。** 当前模型训练 `HOLD/ADD/REDUCE`，并由 HOLD 价值派生 `EXIT`；但 `sellableRatio=1.0` 被写死，[代码](../qlib-service/decision_engine/training/position_dataset.py#L500-L518) 且当前确认段绝对效用和相对 adapter 均为负。离线策略学习在行为分布外会高估动作价值，保守 Q 学习和双重稳健 OPE 需要动作支持或可靠行为概率。[S20][S21]

**系统映射与验收。**

- 继续采用监督式多动作价值，不直接上普通 offline RL。用历史可建仓状态和真实生产持仓快照重建 1/3/5 日标签，显式纳入持仓年龄、T+1 批次、可卖比例和实际退出成本。
- `sellableRatio` 不得恒定，账本可验证的 T+1 锁定样本占比 `>=5%`；Alpha 覆盖 `>=80%`，否则 OOD abstain。
- 确认段策略效用及块 bootstrap 下界均 `>0`，相对现役 adapter 和全程 HOLD 的改善下界均 `>0`。
- 每个 DIRECT 动作至少有 `200` 个有效 OOS 样本，覆盖 3 年和 3 个事前状态；任一动作占比 `>85%` 视为塌缩，`POSITION_MODEL_ENABLED` 保持关闭。

## 两阶段发布门禁

### 阶段 A：候选自身绝对合格

| 维度 | 硬门禁 |
|---|---|
| 数据合同 | P0-0 覆盖率、非恒定、非全 UNKNOWN 和哈希审计全部通过 |
| 风险合同 | `riskProfileVersion` 正确；开放风险 `<=5%`；单票 `<=20%`；不增加其他风险预算 |
| 原始机会 | 至少一个预注册打法和路径桶的 10bps 均值、块 bootstrap 下界均 `>0` |
| 账户结果 | 5bps、10bps、下一开盘均为正；10bps 净 R 下界 `>0`；最大回撤 `<=10%` |
| 稳定性 | 滚动 12 月账户盈利概率 `>=70%`；至少 5 个 purged OOS 窗中 4 个为正 |
| 执行 | 成交意图覆盖 `>=95%`，支持部分/未成交、涨跌停、T+1 和人工延迟 |
| 覆盖 | 年化实际成交 `80-160`，只作约束，不优先于净期望 |

第一只通过阶段 A 的模型只能标记为“建立合格基线”。当前 `+0.4229%` 不满足这一资格。

### 阶段 B：同合同配对改进

只有基线已为 `BASELINE_QUALIFIED`，才比较同事件、同风险、同费用、同执行和同最终确认窗的挑战者。挑战者必须满足：

- 配对超额收益块 bootstrap 95% 下界 `>0`；
- 10bps 收益、净 R 下界、滚动 12 月盈利概率和最大回撤均不得恶化；
- SPA `p<0.05` 或 DSR `>=0.95`；
- 任一合同、数据或审计缺项均 `KEEP_CURRENT`，不得用交易数或仓位弥补。

## 建议实验顺序

1. 修复 `/tmp/current-v3-account-repro.json` 暴露的风险合同与账户回放问题，建立首个 `BASELINE_QUALIFIED` 基线。
2. 修复 V4 的 53 个恒定特征和关键业务字段缺失，按分段重新审计覆盖率。
3. 重做候选、成交和费后标签，先证明预注册打法/路径存在绝对正期望。
4. 接入真实执行、部分成交和条件滑点，再做嵌套 purged walk-forward。
5. 数据合格后依次评估校准、批次 ranker、去相关和状态稳健性。
6. 最后重建 position 数据集；在绝对效用和相对 adapter 下界均为正前保持关闭。

## 主要来源

- [S1] Almgren & Chriss, *Optimal Execution of Portfolio Transactions*, Journal of Risk, 2001. https://doi.org/10.21314/JOR.2001.041
- [S2] Microsoft Qlib, *Portfolio Strategy and cost-aware backtest*. https://qlib.readthedocs.io/en/latest/component/strategy.html
- [S3] 财政部、税务总局，证券交易印花税减半征收公告，2023. https://www.gov.cn/zhengce/zhengceku/202308/content_6900443.htm
- [S4] 上海证券交易所，主板交易机制、100 股单位、涨跌停、价格与时间优先. https://english.sse.com.cn/start/trading/mechanism/
- [S5] 深圳证券交易所，*Trading Rules of Shenzhen Stock Exchange (2023 Revision)*. https://www.szse.cn/English/rules/siteRule/P020240911598586572526.pdf
- [S6] Niculescu-Mizil & Caruana, *Predicting Good Probabilities with Supervised Learning*, ICML 2005. https://doi.org/10.1145/1102351.1102430
- [S7] scikit-learn, *Probability calibration*. https://scikit-learn.org/stable/modules/calibration.html
- [S8] Microsoft Research, *Learning to Rank Using Gradient Descent*, 2005. https://www.microsoft.com/en-us/research/publication/learning-to-rank-using-gradient-descent/
- [S9] Markowitz, *Portfolio Selection*, Journal of Finance, 1952. https://doi.org/10.1111/j.1540-6261.1952.tb01525.x
- [S10] Ledoit & Wolf, *A Well-Conditioned Estimator for Large-Dimensional Covariance Matrices*, 2004. https://doi.org/10.1016/S0047-259X%2803%2900096-4
- [S11] DeMiguel, Garlappi & Uppal, *Optimal Versus Naive Diversification*, RFS, 2009. https://doi.org/10.1093/rfs/hhm075
- [S12] López de Prado, *Advances in Financial Machine Learning*, Wiley, 2018. https://www.wiley.com/en-fr/Edition-p-9781119482086
- [S13] Politis & Romano, *The Stationary Bootstrap*, JASA, 1994. https://doi.org/10.1080/01621459.1994.10476870
- [S14] Bailey & López de Prado, *The Deflated Sharpe Ratio*, JPM, 2014. https://doi.org/10.3905/jpm.2014.40.5.094
- [S15] Hansen, *A Test for Superior Predictive Ability*, JBES, 2005. https://doi.org/10.1198/073500105000000063
- [S16] Microsoft Qlib, *Reinforcement Learning in Quantitative Trading: Order Execution*. https://qlib.readthedocs.io/en/latest/component/rl/overall.html
- [S17] LightGBM, *LambdaRank*. https://lightgbm.readthedocs.io/en/latest/Advanced-Topics.html#lambdarank
- [S18] CatBoost, *Ranking objectives and metrics*. https://catboost.ai/en/docs/concepts/loss-functions-ranking
- [S19] Cao et al., *InvariantStock: Learning Invariant Features for Mastering the Shifting Market*, TMLR 2024. https://openreview.net/forum?id=dtNEvUOZmA
- [S20] Kumar et al., *Conservative Q-Learning for Offline Reinforcement Learning*, NeurIPS 2020. https://papers.nips.cc/paper/2020/hash/0d2b2061826a5df3221116a5085a6052-Abstract.html
- [S21] Dudík, Langford & Li, *Doubly Robust Policy Evaluation and Learning*, ICML 2011. https://arxiv.org/abs/1103.4601

来源检索与本地审计日期：2026-09-15。
