# V3 三模型同口径 POC 结果

> 实验日期：2026-09-10
> 状态：第一轮离线 POC 完成；第二轮最佳组合已切换为生产 `DIRECT` 基准
> 数据摘要：`cc4f92dd7d6a8a24b59ec775b1b578621af7e2e0e13334cce89bf2e1aeaee7c5`

## 结论

**三组模型均未达到生产门槛，当前不得替换生产模型。**

CatBoost Ranker 是唯一值得进入下一轮的候选：3 个种子下，93 个样本外交易日的
Top5 均值分别为 `+0.048R`、`+0.088R`、`+0.059R`。但最差 bootstrap 下界仍为
`-0.170R`，且最新时间窗持续为负，因此不能判定存在稳定正期望。

更重要的结论是：

- 三种模型都能明显预测是否成交；
- 三种模型都不能稳定预测成交后的胜负和 R 幅度；
- 换 GBDT 库没有解决核心问题，下一阶段应先补齐预测成交后结果的特征。

## 实验合同

### 数据

- 73,004 个成熟候选。
- 37,516 个成交并完成结算的路径。
- 124 个独立交易日。
- 87 个固定合同特征。
- R 标签统一改为计划入场价与计划止损价定义的风险。
- 历史 `10:20/13:40` 时点从错误的 HHMM 数值恢复为分钟数语义。

修正后 R 分布：

| 指标 | 数值 |
|---|---:|
| 最小 | -40.090R |
| P1 | -3.604R |
| P10 | -1.502R |
| 中位数 | -0.475R |
| 均值 | -0.240R |
| P90 | +1.444R |
| P99 | +3.429R |
| 最大 | +26.031R |

### 切分

所有模型共享 3 个按真实标签区间 purge 的 expanding walk-forward：

| Fold | 训练结束 | 校准区间 | 验证区间 | 训练/校准/验证 | Purge |
|---|---|---|---|---:|---:|
| 1 | 2026-04-15 | 04-16 至 04-22 | 04-23 至 06-09 | 15,122 / 2,943 / 19,411 | 514 |
| 2 | 2026-05-26 | 05-27 至 06-09 | 06-10 至 07-23 | 32,168 / 5,516 / 17,498 | 419 |
| 3 | 2026-07-03 | 07-06 至 07-23 | 07-24 至 09-08 | 48,520 / 6,630 / 16,843 | 585 |

当日全部股票及三条价格路径保持在同一 partition。标签截尾点、相关性分箱和概率
校准器只使用各 fold 的训练或校准区间。

### 模型

每个模型均训练：

1. `pFill` 分类头；
2. `pWinGivenFill` 分类头；
3. 胜单 R 幅度稳健回归头；
4. 亏单 R 幅度稳健回归头；
5. 条件 Q10 头；
6. 按交易日分组的 Top-K Ranker。

动作价值按以下公式计算，不重复乘胜率：

```text
expectedNetR =
  pWinGivenFill * winPayoffR
  + (1 - pWinGivenFill) * lossPayoffR

candidateUtility = pFill * expectedNetR
```

实验模型：

- LightGBM 4.7.0：Huber + Quantile + LambdaRank。
- CatBoost 1.2.10：Huber + Quantile + YetiRankPairwise。
- XGBoost 3.2.0：Pseudo-Huber + Quantile + LambdaMART。
- 每个模型运行种子 `42 / 7 / 2026`，每次 3 folds、180 棵树。

## 多种子结果

| 模型 | 动作价值 Top5 均值 | 最差种子下界 | Ranker Top5 均值 | Ranker 最差下界 | Q10 覆盖率 | 结论 |
|---|---:|---:|---:|---:|---:|---|
| LightGBM | -0.149R | -0.394R | -0.056R | -0.355R | 84.2% | 未通过 |
| CatBoost | -0.170R | -0.400R | **+0.065R** | -0.170R | 86.3% | 未通过，保留候选 |
| XGBoost | -0.231R | -0.512R | -0.133R | -0.423R | 84.3% | 未通过 |

Q10 的目标覆盖率为约 90%。三个模型都偏低，说明尾部损失仍被低估，不能用于放大
仓位。

## 相对常数基线

以 seed 42 为例，三 folds 聚合结果：

| 模型 | pFill Brier 技能 | pWin Brier 技能 | NetR MAE 技能 |
|---|---:|---:|---:|
| LightGBM | +60.1% | -2.6% | -1.7% |
| CatBoost | +60.1% | -3.0% | -1.7% |
| XGBoost | +60.2% | -2.9% | -1.7% |

解释：

- `pFill` 明显优于只使用训练成交率的常数先验，成交路径模型有效。
- `pWin` 比只使用训练胜率更差，当前特征没有稳定的方向预测增量。
- `netR` 比只使用训练 R 中位数更差，当前特征没有稳定的幅度预测增量。

因此不能因为成交概率模型有效，就推断整个动作价值模型有效。

## CatBoost Ranker 稳定性

| Seed | Fold 1 | Fold 2 | Fold 3 | 全部窗口均值 | 全部窗口下界 |
|---|---:|---:|---:|---:|---:|
| 42 | +0.070R | +0.266R | -0.191R | +0.048R | -0.164R |
| 7 | +0.169R | +0.247R | -0.152R | +0.088R | -0.129R |
| 2026 | +0.160R | +0.169R | -0.153R | +0.059R | -0.170R |

三个种子都在最新 Fold 3 失效，说明它不是随机种子偶然波动，而是近期市场分布下
排序关系发生了变化。

## 数据覆盖诊断

虽然每个 fold 有 57 个活跃特征，但大量关键字段缺少横截面变化：

- 72,847 / 73,004 条历史样本的板块阶段为 `UNKNOWN`。
- `formulaScore` 有 99.78% 样本为 0。
- `marketAllowed` 有 99.92% 样本取同一个值。
- 24 个字段在至少 99.5% 样本中为同一个值。
- 动量、资金、流动性可预测成交，但不足以稳定解释成交后的方向和幅度。

这解释了三种树模型表现接近：它们使用了相同的低信息量输入，继续增加树数量或换库
不会自动产生新信息。

## 运行性能

三种模型的 FC CPU 批量推理均远低于 100ms 门槛，包体也在可接受范围：

- LightGBM 约 3–4ms / 240 路径，约 3MB。
- CatBoost 约 2–4ms / 240 路径，约 1.2MB。
- XGBoost 约 1–2ms / 240 路径，约 2.7MB。

生产阻断原因是预测质量，不是性能或部署成本。

## 下一轮建议

1. **重建历史板块特征。**
   - 从历史板块资金、扩散、排名和阶段恢复非 `UNKNOWN` 的真实横截面。
2. **修复公式与召回特征覆盖。**
   - 历史回放不能让 99.78% 的 `formulaScore` 为零。
   - 保存四路召回来源、横截面分位和探索样本标记。
3. **增加成交后路径特征。**
   - 触发后相对 VWAP 恢复、突破站稳、量能延续、主力/小单背离变化。
   - 这些特征只能由触发时点及之后的复核模型使用，首次决策不能泄漏未来。
4. **保留 CatBoost Ranker 为唯一下一轮 challenger。**
   - LightGBM 继续作为动作价值基线。
   - 暂停 XGBoost，当前没有显示独立增益。
5. **重新积累独立交易日。**
   - 124 日只有三个大窗口；最新窗口失效时不能靠调参掩盖。

下一轮只有在 CatBoost Ranker 与动作价值头同时满足下列条件时才能讨论生产替换：

- 每个样本外窗口 Top5 均值为正；
- 3-seed 最差 bootstrap 下界大于 0；
- Q10 覆盖率在 88%–92%；
- pWin 与 NetR 相对常数基线技能分为正；
- 正期望覆盖率不是通过几乎永远不出信号获得。

## 产物

- 最终 seed 42：
  `poc-artifacts/v3-model-bakeoff/final-seed42/report.md`
- 最终 seed 7：
  `poc-artifacts/v3-model-bakeoff/final-seed7/report.md`
- 最终 seed 2026：
  `poc-artifacts/v3-model-bakeoff/final-seed2026/report.md`
- 多种子汇总：
  `poc-artifacts/v3-model-bakeoff/final-stability/stability.md`

`poc-artifacts/` 已被 Git 忽略，只保留在本机，不会误发为生产模型。

## 第二轮 V4 实施结果

第二轮已完成以下数据修复：

- 特征协议升级为 `opportunity-score-feature.v4`，共 104 维；
- 历史行业阶段按申万一级行业成员生效区间重建，`UNKNOWN` 降至
  715 / 72,847；
- `formulaScore=0` 降至 2 / 72,847；
- 四路召回来源完整覆盖，另保留 4,074 条稳定探索样本；
- 41,544 条结果带有独立的触发后复核特征，且这些字段不进入首次决策；
- 最终得到 72,847 条成熟候选、37,491 条成交路径、120 个信号日。

训练结构收敛为：

1. LightGBM `pFill` 与 `pWinGivenFill` 分类头；
2. LightGBM 胜单 R / 亏单 R 两个 Huber 头；
3. LightGBM Q10 尾部头，并只用校准区间修正覆盖率；
4. CatBoost `YetiRankPairwise` 横截面排序头；
5. 排序标签明确区分亏损、未成交/零收益、小正收益、中位以上正收益和高分位
   正收益；
6. 分类训练使用类别平衡、近期样本、打法/路径分层和高分困难负样本权重。

三种子复验结果：

| 组件 | 样本外结果 | 结论 |
|---|---:|---|
| LightGBM 动作价值 Top5 | `+0.026R` | 均值略正，但最差种子下界 `-0.143R` |
| CatBoost Ranker Top5 | `+0.158R` | 当前最强组件，但最差种子下界 `-0.148R` |
| 正期望过滤 + CatBoost 排序 | `-0.077R` | 严格组合仍受近期负窗口拖累 |
| LightGBM Q10 覆盖率 | `89.4%` | 已进入 88%–92% 目标区间 |
| LightGBM pWin 技能 | `-5.3%`（最差种子） | 尚未优于常数胜率 |
| LightGBM NetR 技能 | `-0.7%`（最差种子） | 尚未优于常数中位数 |

因此，**效果和潜力最优的生产组合确定为 LightGBM 稳健动作价值头 +
CatBoost Ranker**。按用户 2026-09-10 的最新指示，该组合直接作为
`usagePolicy=DIRECT` 基准替换旧三头模型；`productionEligible` 继续记录真实
门槛结果，不因直接启用而伪造为通过。后续每日使用新增成熟样本全量重训并执行
三折、三种子回测；回测结果写入量化汇报。

当前激活版本为 `opportunity-score.20260910T101955Z`。CatBoost 排序头以 JSON
对称树部署，由 NumPy 推理；与原生 CatBoost 对拍 1,000 条样本的最大绝对误差为
`1.67e-16`。

生产职责严格分离：

- LightGBM 决定 `pFill`、`pWinGivenFill`、`expectedNetR` 和 Q10 下界；
- CatBoost 只提供 0–1 横截面 `rankingScore`；
- `expectedNetR <= 0` 仍禁止新增风险，排序头不能覆盖费用、现金、T+1、
  价格合法性和账户风控；
- 触发后复核特征仍只用于独立复核数据集，不泄漏到首次决策模型。

第二轮报告位于：

```text
poc-artifacts/v3-model-bakeoff/v4-ensemble-seed42/
poc-artifacts/v3-model-bakeoff/v4-ensemble-seed7/
poc-artifacts/v3-model-bakeoff/v4-ensemble-seed2026/
poc-artifacts/v3-model-bakeoff/v4-ensemble-stability/
```

外部实现依据仍采用已固定版本的 LightGBM、CatBoost 和 Qlib
DoubleEnsemble 研究结果，详见
[`v3-model-selection-github.md`](./v3-model-selection-github.md)。其中
DoubleEnsemble 仅借鉴困难样本重加权思想，不引入 Qlib runtime。

## 第三轮 V5 资金连续性修复

V5 将首次决策合同扩展到 120 维，新增主力/小单五日合计、流入天数、连续
方向、趋势斜率、资金分歧天数，以及资金、日线、分时和板块的显式可用性
标识。历史升级只读取决策时点可见的数据；盘中样本不使用当日盘后资金。

数据集包含 73,215 条成熟候选、37,544 条完整成交路径和 126 个独立交易日。
其中 69,887 条具有完整五日双资金序列，72,411 条至少具有一日资金历史，
72,388 条具有有效板块上下文。

三折三种子复验结果：

| 组件 | 样本外结果 | 结论 |
|---|---:|---|
| LightGBM 动作价值 Top5 | `+0.0687R` | 最差种子下界 `-0.1958R` |
| CatBoost Ranker Top5 | `+0.3004R` | 最差种子下界 `+0.0547R`，但仍有负窗口 |
| 正期望过滤 + CatBoost 排序 | `+0.2029R` | 最差种子下界 `-0.0508R` |
| Q10 覆盖率 | `91.8%` | 位于 88%–92% 目标区间 |
| pWin 技能 | `-0.61%`（最差种子） | 仍未稳定优于常数胜率 |
| NetR 技能 | `+0.22%`（最差种子） | 已略高于常数中位数 |

V5 对排序能力有实质改善，但组合尚未满足“所有窗口为正”和下界大于零的正式
晋级条件。因此激活版本 `opportunity-score.20260910T112451Z` 作为当前最佳
`DIRECT` 基准，继续如实记录 `productionEligible=false`。完整本地报告位于：

```text
poc-artifacts/v3-model-bakeoff/v5-seed42/
poc-artifacts/v3-model-bakeoff/v5-seed7/
poc-artifacts/v3-model-bakeoff/v5-seed2026/
poc-artifacts/v3-model-bakeoff/v5-stability/
```
