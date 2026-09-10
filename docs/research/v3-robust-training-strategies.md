# V3 机会模型稳健训练策略调研

> 调研日期：2026-09-10
> 范围：只研究训练与评估方法，不修改代码，不访问生产数据或任何密钥。
> 证据优先级：GitHub 官方仓库源码、仓库内官方文档和许可证。链接尽量固定到本次调研时的 commit。

## 结论摘要

当前最优先的问题不是更换模型，而是**隔离旧标签并修复风险单位**。`-504R ~ +361R`
不符合 1 至 5 个交易日、有限涨跌幅和既定止损合同下的正常经济范围。它会让 L2
回归、残差下界、尾部损失和 OOD 元数据一起失真。Huber、L1、winsorization 都只能
降低污染后的伤害，不能把错误分母变成正确标签。

建议按以下顺序推进：

1. **P0：重建标签世代。** 固定使用决策时已经确定的计划风险，而不是成交改善后的
   `actual fill - stop`；为风险单位设置可解释的最小有效门槛；升级 outcome/dataset
   schema，只重放或接收新口径样本，禁止新旧 `netR` 混训。
2. **P0：保留真实三障碍路径。** 成交、止损、止盈、垂直时间障碍、费用、滑点、
   T+1 和同 bar 歧义仍由现有生产结算器处理。借鉴 triple-barrier 的是“事件起止
   区间和先触达语义”，不是用收盘收益替换真实成交。
3. **P1：回归头改为稳健基线竞赛。** 在每个 fold 的训练子集内计算标签截尾点，
   同时比较 LightGBM `huber`、`regression_l1` 和当前 L2；验证与测试始终用未截尾
   原始标签计分。首选 Huber，L1 作为稳定性对照。
4. **P1：按实际标签区间 purge。** 每条样本保存 `t0` 和最终退出/到期时间 `t1`，
   删除任何与验证区间重叠的训练事件，并在验证区间之后加 embargo。固定删除 5 个
   信号日只是近似，不足以覆盖延迟成交、停牌和跨日标签。
5. **P1：保留两阶段经济模型，增加排序 challenger。** 当前
   `pFill * E(netR | fill)` 在数学上成立；不能再乘一次 `pWin`。可增加按信号日分组
   的 LambdaRank，专门优化 Top3/Top5，但不得用 NDCG 代替真实费后净 R 验收。
6. **P1：拆开 OOD、漂移和模型失效。** 单行越界、批次分布漂移、预测残差漂移是
   三件事。`30/31 OOD` 首先应视为特征合同或训练/推理生成链不一致，逐字段输出
   违规原因；不能仅靠“超过 10% 特征越界”作总判断。

## 一、现状证据与根因判断

### 1.1 当前代码状态

- 当前结算器已经使用计划入场价计算风险：
  [`shared/opportunityOutcomeResolver.js#L293-L320`](../../shared/opportunityOutcomeResolver.js#L293-L320)。
  `actualFillRiskCash` 只作为诊断字段保存，`riskBasis` 为
  `PLANNED_PRICE_CONTRACT`。
- Git 历史显示该修复来自 `de07c9a`（`fix: 按计划价格合同计算机会R值`）。
- 数据集加载器仍直接读取 `metrics.netR`，未检查 `riskBasis` 或标签世代：
  [`qlib-service/opportunity_dataset.py#L94-L108`](../../qlib-service/opportunity_dataset.py#L94-L108)。
- outcome schema 仍是 `opportunity-outcome.v1`。因此旧的实际成交价分母标签与新的
  计划价分母标签有可能在历史基线中不可区分地混合。
- `expectedNetR` 当前使用普通 L2：
  [`qlib-service/train_opportunity_score.py#L194-L214`](../../qlib-service/train_opportunity_score.py#L194-L214)。
- 当前切分按信号日期固定 purge 5 日：
  [`qlib-service/time_splits.py#L19-L140`](../../qlib-service/time_splits.py#L19-L140)。
- 当前 OOD 是训练特征 0.5%/99.5% 分位外再放宽 5% span，并统计越界特征占比：
  [`qlib-service/opportunity_model.py#L232-L258`](../../qlib-service/opportunity_model.py#L232-L258)。

### 1.2 对已知异常的判断

| 现象 | 最可能解释 | 应先做的验证 |
|---|---|---|
| 73,004 样本 `netR=-504R~+361R` | 旧数据使用接近 0 的 `actual fill-stop` 分母；也可能混有计划价止损宽度异常 | 按 `riskBasis`、生成 commit/时间、`initialRiskCash/costCash` 分桶，列出极值样本的分母 |
| 31 候选中 30 个 OOD | 特征合同、枚举 one-hot、单位或生成链发生系统性偏移，单纯市场 regime 变化不足以解释如此高比例 | 输出每个特征的训练 P0.5/P50/P99.5、当前值、违规方向和 UNKNOWN 命中率 |
| `expectedNetR=-1.14R~-10.46R` | 极端标签驱动 L2 叶值和残差尾部；也可能是当前样本落入训练稀疏叶 | 对同一 holdout 比较原始 L2、Huber、L1，并做叶覆盖/邻域样本数诊断 |

**关键判断：** 当前源码中的分母公式已修正，不代表已经发布的 73,004 条历史标签
自动修正。应把它们视为“待证实的旧标签世代”，而不是直接在训练阶段 winsorize 后
继续使用。

## 二、Triple-barrier 与真实 R 标签

### 可借鉴实现

`baobach/mlfinpy` 的 triple-barrier 实现把每个事件表示为开始时间、波动目标
`trgt`、止盈/止损倍数和垂直障碍，并记录最早触达时间：

- [`mlfinpy/labeling/labeling.py`](https://github.com/baobach/mlfinpy/blob/89511cc1ee4695beed0044bbbc6665d98ac4a5c5/mlfinpy/labeling/labeling.py)
- [`tests/test_labels.py`](https://github.com/baobach/mlfinpy/blob/89511cc1ee4695beed0044bbbc6665d98ac4a5c5/tests/test_labels.py)
- 许可证：[MIT](https://github.com/baobach/mlfinpy/blob/89511cc1ee4695beed0044bbbc6665d98ac4a5c5/LICENSE)

源码中 `get_events()` 会先按 `target > min_ret` 过滤过小波动目标，再执行止盈、止损
和垂直障碍；`get_bins()` 输出实际收益和先触达标签。这提供两个直接可用的原则：

1. 标签必须有明确的事件区间 `[t0, t1]`，供结算与 purge 共用。
2. 风险目标必须先通过最小有效宽度检查，不能允许接近 0 的风险尺度进入标签。

### V3 应采用的标签合同

建议保留现有真实成交结算，在此之上固定以下字段：

```text
t0                 = 信号可执行时间
tEntry             = 实际成交时间；未成交为空
t1                 = 止盈、止损或时间退出的最终结算时间
plannedEntryPrice  = 决策发布时冻结的路径入场价
plannedStopPrice   = 决策发布时冻结的止损价
plannedRiskCash    = (plannedEntryPrice - plannedStopPrice) * quantity
actualFillRiskCash = (actualFillPrice - plannedStopPrice) * quantity，仅诊断
netPnl             = 真实成交与退出现金流减全部费用
netRRaw            = netPnl / effectiveRiskCash
```

其中：

```text
effectiveRiskPerShare =
  max(plannedEntryPrice - plannedStopPrice,
      volatilityRiskFloor,
      executionCostFloor)
```

- `volatilityRiskFloor` 应只使用 `t0` 已知信息，例如计划价乘以训练/推理一致的
  ATR 百分比下限。
- `executionCostFloor` 至少覆盖双边佣金、卖出印花税、过户费和保守滑点折算到每股
  的金额，避免“理论止损宽度小于交易摩擦”。
- 如果计划风险小于门槛，优先把路径标记为 `INVALID_RISK_CONTRACT`，不要静默用
  floor 把本不合法的计划包装成有效机会。
- 成交改善只改变 `netPnl`，不重新定义下注前的 1R。实际成交风险保留用于执行质量
  分析，不作为模型监督分母。

### 迁移要求

- 新建不可混淆的标签版本，例如 `opportunity-outcome.v2` /
  `opportunity-dataset.v2`，并把 `riskBasis`、风险 floor 参数和费用版本写入样本。
- 旧样本只有在能从不可变行情、计划合同和费用版本完全重放时才能迁移；否则排除，
  不能仅按 `[-xR,+xR]` 截尾后冒充新口径。
- 同时保留 `netRRaw` 与 `netRTrain`。前者用于经济验收和审计，后者才允许在训练
  fold 内截尾。
- 三障碍只决定退出路径。不要直接照搬 `mlfinpy` 的 close-to-close 收益，因为它
  没有本项目的 A 股涨跌停成交、滑点、费用、T+1 和同 bar 歧义规则。

## 三、LightGBM 稳健回归与标签截尾

### 官方实现证据

LightGBM 官方支持 `regression_l1`、`huber` 和 `quantile`：

- [参数文档](https://github.com/lightgbm-org/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/docs/Parameters.rst)
- [L1/Huber 源码](https://github.com/lightgbm-org/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/src/objective/regression_objective.hpp)
- 许可证：[MIT](https://github.com/lightgbm-org/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/LICENSE)

源码表明：

- L2 梯度随残差线性增大，最容易被数百 R 标签支配。
- L1 使用残差符号，叶输出基于中位数，对极端值最不敏感，但优化结果偏向条件中位数，
  不等于业务需要的条件均值。
- Huber 在 `abs(residual) <= alpha` 时使用 L2 梯度，超过后将梯度截为
  `sign(residual) * alpha`。LightGBM 的 `alpha` 是该实现中的残差阈值，必须基于
  修复后的 R 尺度调参，不能把默认值机械理解为“90% 分位”。

Microsoft Qlib 也提供了训练区间拟合的稳健归一化和标签裁剪范式：

- [`qlib/data/dataset/processor.py` 的 `RobustZScoreNorm`](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/qlib/data/dataset/processor.py)
- [`qlib/contrib/data/processor.py` 的 `clip_label_outlier`](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/qlib/contrib/data/processor.py)
- 许可证：[MIT](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/LICENSE)

Qlib 的关键可借鉴点是统计量只在 fit 区间估计，并明确警告 `fit_end_time` 不能包含
测试数据；不是照抄其横截面 z-score 标签定义。

### 建议实验

每个 walk-forward fold 独立执行：

1. 只在训练子集计算 `q_low/q_high`，首轮比较 `[0.5%,99.5%]`、
   `[1%,99%]` 和基于业务可实现边界的截尾。
2. 用同一份截尾后的 `netRTrain` 分别训练 L2、Huber、L1。
3. 校准集和测试集不参与截尾点估计；模型输入标签可以按训练阈值裁剪，但所有最终
   指标必须同时报告未截尾 `netRRaw` 和稳健指标。
4. 主指标使用按交易日聚合的 `Top3/Top5 mean netR`、bootstrap 下界、最大回撤、
   MAE/median AE；补充报告最差 10% 条件均值。

推荐顺序是 **Huber 主 challenger、L1 稳定性基线、L2 仅保留对照**。不要在分母
错误仍存在时通过重度截尾制造漂亮结果；也不要只看 winsorized MAE。

## 四、Purged/Embargo Walk-forward

### 可借鉴实现

`mlfinpy` 的 `ml_get_train_times()` 按每条样本的信息区间删除三类重叠：训练事件
起点落入测试区间、终点落入测试区间、训练事件包围测试区间：

- [`mlfinpy/cross_validation/cross_validation.py`](https://github.com/baobach/mlfinpy/blob/89511cc1ee4695beed0044bbbc6665d98ac4a5c5/mlfinpy/cross_validation/cross_validation.py)

`skfolio` 提供维护更活跃、测试更完整的 walk-forward 和 CPCV：

- [`WalkForward`](https://github.com/skfolio/skfolio/blob/085485b0f35576c1b36b4c4253cb7b944fee0c6f/src/skfolio/model_selection/_walk_forward.py)
- [`CombinatorialPurgedCV`](https://github.com/skfolio/skfolio/blob/085485b0f35576c1b36b4c4253cb7b944fee0c6f/src/skfolio/model_selection/_combinatorial.py)
- [对应测试](https://github.com/skfolio/skfolio/tree/085485b0f35576c1b36b4c4253cb7b944fee0c6f/tests/test_model_selection)
- 许可证：[BSD-3-Clause](https://github.com/skfolio/skfolio/blob/085485b0f35576c1b36b4c4253cb7b944fee0c6f/LICENSE)

### V3 应采用的切分

- 外层：按交易日扩展窗口 walk-forward，最后一段保持永久 blind holdout。
- 内层：训练与概率校准之间也做 interval purge；调 Huber、winsor 阈值、树参数和
  ranking relevance bins 都只能使用内层窗口。
- Purge：依据每个样本真实 `[t0,t1]` 是否与验证/测试标签区间重叠，而不是只减固定
  5 个日期。
- Embargo：在测试区间之后删除至少覆盖最大特征回看污染或数据落库延迟的日期。
  对只使用过去信息的扩展窗，测试后的 embargo 主要用于 CPCV/双向组合切分；普通
  单向 walk-forward 的核心是测试前 interval purge。
- 同一 `tradeDate` 的全部股票和三条价格路径必须在同一 partition，不能逐行随机拆分。
- 记录每个 fold 的信号起止、标签起止、purged/embargo 样本数和训练标签截尾点，
  使报告可审计。

不建议直接替换为 `skfolio.CombinatorialPurgedCV` 后结束工作：它的
`purged_size/embargo_size` 是观测数量，V3 的退出时间可因停牌、未成交和不同持有期
而变化。应借鉴其 split/path 测试方式，核心 purge 仍按事件区间实现。

## 五、Ranking 与两阶段经济模型

### LightGBM LambdaRank 可借鉴点

- [`rank_objective.hpp`](https://github.com/lightgbm-org/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/src/objective/rank_objective.hpp)
  按 query 边界做 pairwise 梯度，并以 NDCG 变化量加权。
- [官方 sklearn ranking 测试](https://github.com/lightgbm-org/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/tests/python_package_test/test_sklearn.py#L203-L225)
  展示 `LGBMRanker.fit(..., group=..., eval_group=..., eval_at=[1,3])`。
- 参数文档说明 relevance label 必须是非负整数，`label_gain` 控制收益，
  `lambdarank_truncation_level` 应接近目标 `k`。

### 两种 challenger

**A. 推荐先落地：稳健 hurdle/two-stage**

```text
candidateUtility =
  pFill
  * (
      pWinGivenFill * E(netRRaw | win, fill)
      + (1 - pWinGivenFill) * E(netRRaw | loss, fill)
    )
```

- `pFill` 使用全部成熟候选。
- `pWinGivenFill`、赢单 R、亏单 R 只使用真实可成交且完整结算样本。
- 两个 payoff magnitude 头使用 Huber/L1；损失头可直接预测负 R，避免符号还原错误。
- 当前 `pFill * E(netR | fill)` 也是正确且更简单的基线，因为 signed
  `E(netR | fill)` 已经包含胜负概率。
- **禁止** `pFill * pWinGivenFill * expectedNetR`：若 `expectedNetR` 已是带胜负的
  条件期望，这会重复乘胜率并忽略亏损幅度。

**B. 并行 challenger：按日 LambdaRank**

- query/group = `tradeDate`，排序对象是当日全市场候选及其三路径。
- relevance 使用训练 fold 内基于 `candidate realized utility` 的离散等级，例如
  负收益、零/未成交、小正收益、大正收益；分箱边界只由训练 fold 得出。
- `lambdarank_truncation_level` 围绕 Top5 目标测试 5 至 8，不使用默认 30 直接上线。
- 线上 rank score 只负责相对顺序，不冒充概率或 R。动作门槛仍读取校准的
  `pFill`、`pWinGivenFill`、费后期望和下界。
- 验收以原始费后 `NetR@3/@5`、下界、回撤、覆盖率为准，NDCG 仅作训练诊断。

现有评估已经使用 `pFill * predictedNetR` 排序
（[`train_opportunity_score.py#L656-L680`](../../qlib-service/train_opportunity_score.py#L656-L680)），
因此 LambdaRank 是“直接优化横截面 Top-K”的 challenger，不是修复错误 R 标签的替代品。

## 六、OOD 与特征漂移

### 成熟实现

`Evidently` 提供按列漂移和数据集漂移聚合：

- [`DataDriftPreset`](https://github.com/evidentlyai/evidently/blob/a4aa4c2b37fe7a4344cc5031f566deccf3d69e4f/src/evidently/presets/drift.py)
- [归一化 Wasserstein](https://github.com/evidentlyai/evidently/blob/a4aa4c2b37fe7a4344cc5031f566deccf3d69e4f/src/evidently/legacy/calculations/stattests/wasserstein_distance_norm.py)
- [Jensen-Shannon distance](https://github.com/evidentlyai/evidently/blob/a4aa4c2b37fe7a4344cc5031f566deccf3d69e4f/src/evidently/legacy/calculations/stattests/jensenshannon.py)
- 许可证：[Apache-2.0](https://github.com/evidentlyai/evidently/blob/a4aa4c2b37fe7a4344cc5031f566deccf3d69e4f/LICENSE)

`river` 提供适合流式监控的变化检测：

- [`KSWIN`](https://github.com/online-ml/river/blob/b50439f2fac102455f1e99e7b172d5fc3ed12cf6/river/drift/kswin.py)
- [`ADWIN`](https://github.com/online-ml/river/blob/b50439f2fac102455f1e99e7b172d5fc3ed12cf6/river/drift/adwin.py)
- 许可证：[BSD-3-Clause](https://github.com/online-ml/river/blob/b50439f2fac102455f1e99e7b172d5fc3ed12cf6/LICENSE)

### 建议的三层监控

1. **特征合同/单行 OOD**
   - 缺字段、非有限值、单位错误、未知枚举、one-hot 多选/全空属于硬错误。
   - 连续特征报告 robust z-score、训练分位位置和违反字段名；不要只返回布尔值。
   - 对 31 条候选这类小批次，先做逐字段诊断，不用小样本显著性检验下结论。

2. **批次分布漂移**
   - 用最近 20 至 60 个交易日的推理样本与对应训练参考窗比较。
   - 连续值优先报告 Wasserstein/PSI；分类与 one-hot 组报告 Jensen-Shannon 和
     UNKNOWN 比例。按 market/sector/time/playbook/route 分层，避免样本构成变化
     被误判成特征生成错误。
   - 做多重检验控制，并同时给 effect size；不要只看 p-value。

3. **性能/概念漂移**
   - 成熟标签到达后，对 Brier、LogLoss、raw NetR@K、残差中位数和尾部损失运行
     ADWIN/Page-Hinkley 类流式检测。
   - 训练多个 walk-forward fold 模型，使用预测分散度作为 epistemic uncertainty。
     OOD 时扩大 `netRLowerBound` 的不确定性，而不是伪造新的期望值。

按项目现有规则，OOD 保留提示但不直接关闭预测。更合理的动作是：合同错误返回
`MODEL_INVALID`；统计 OOD 继续给出 DIRECT 预测，同时展示违规字段、降低置信等级，
并要求正费后期望和风险约束继续成立。

## 七、仓库采用矩阵

| 仓库 | 重点文件 | 许可证 | 建议采用 | 不建议采用 |
|---|---|---|---|---|
| [baobach/mlfinpy](https://github.com/baobach/mlfinpy) | `labeling/labeling.py`、`cross_validation/cross_validation.py` | MIT | 三障碍事件合同、按 `[t0,t1]` purge 的区间判断 | 不照搬 close-to-close 标签、线程框架或固定百分比 embargo；不替换本项目真实成交结算 |
| [lightgbm-org/LightGBM](https://github.com/lightgbm-org/LightGBM) | `regression_objective.hpp`、`rank_objective.hpp`、`docs/Parameters.rst` | MIT | Huber/L1 challenger、按日 LambdaRank、Top-K truncation | 不在脏标签上调参；不把 rank score 当概率或 expected R |
| [microsoft/qlib](https://github.com/microsoft/qlib) | `data/dataset/processor.py`、`contrib/data/processor.py` | MIT | 仅训练窗拟合 robust 统计量、保留处理器合同 | 不照搬横截面 z-score 标签；会改变 R 的经济含义 |
| [skfolio/skfolio](https://github.com/skfolio/skfolio) | `_walk_forward.py`、`_combinatorial.py` | BSD-3-Clause | walk-forward/CPCV API、路径级评估与测试思路 | 不用固定观测数 purge 替代真实事件区间 |
| [evidentlyai/evidently](https://github.com/evidentlyai/evidently) | `presets/drift.py`、Wasserstein/JS stattests | Apache-2.0 | 批次级特征漂移、字段级 effect size 和报告结构 | 不把默认阈值直接当交易闸门；小批次不做过度统计推断 |
| [online-ml/river](https://github.com/online-ml/river) | `drift/kswin.py`、`drift/adwin.py` | BSD-3-Clause | 成熟结果到达后的在线性能漂移 | 不对 31 个横截面候选逐特征启动大量独立在线检测器 |

### 明确不建议直接集成

- [`SeldonIO/alibi-detect`](https://github.com/SeldonIO/alibi-detect) 算法覆盖完整，但
  当前仓库许可证为
  [Business Source License 1.1](https://github.com/SeldonIO/alibi-detect/blob/c2fd0e05c648d353467bdb15fd6149a103b3a981/LICENSE)，
  文件明确声明它不是开源许可证，生产/商业使用受限。除非完成法务确认或锁定一个
  确实处于 Apache-2.0 的旧版本并接受安全维护成本，否则只作为研究参考。
- 不建议复制未标许可证的博客 notebook 或个人 gist。即使算法正确，也缺少可审计
  的许可证、测试和版本边界。
- 不建议用 SMOTE、随机 K-fold 或随机 train/test split 处理该问题。它们不解决
  重叠标签泄漏，并会破坏每日横截面的真实候选分布。

## 八、建议实验与验收门槛

### 实验矩阵

| 变量 | 候选 |
|---|---|
| 标签世代 | 新计划风险合同，仅 v2；可重放旧样本子集 |
| 标签处理 | raw、train-only 0.5/99.5、train-only 1/99、业务边界 clip |
| 回归目标 | L2 对照、Huber、L1 |
| 模型结构 | 当前 `pFill * E(netR|fill)`、hurdle 四头、按日 LambdaRank |
| 验证 | interval-purged expanding walk-forward；独立 calibration；永久 blind holdout |
| OOD | 当前 marginal bounds 对照、字段级 robust distance、批次 Wasserstein/JS、fold ensemble dispersion |

### 最低验收

1. 标签审计中 `riskBasis` 100% 为新合同，风险分母 P0/P0.1/P1 可解释，且不存在
   未声明的零附近分母。
2. 所有 winsor 阈值、归一化统计量、relevance 分箱和超参数都只由各 fold 训练段拟合。
3. 至少三个连续样本外窗口报告 raw `NetR@3/@5`、bootstrap 下界、回撤、成交率和
   覆盖率；不得只报告截尾指标或 NDCG。
4. 与简单公式、常数均值、按日随机排序三类基线比较；交易日为 bootstrap block。
5. OOD 报告可定位到字段和分层；`30/31 OOD` 若由单个 one-hot/单位字段造成，应归类
   为数据合同事故，不归类为市场漂移。
6. 先以新标签重训同一模型，之后才比较 Huber/L1、hurdle 和 LambdaRank。否则无法
   区分收益来自标签修复还是模型变更。

## 最终建议

短期主线应是：

```text
标签 v2 隔离与重放
→ 真实 [t0,t1] interval purge
→ train-only winsor + Huber/L1 对照
→ 保留 pFill * E(netR|fill) 基线
→ hurdle 与按日 LambdaRank 并行 challenger
→ 字段级 OOD + 批次漂移 + 成熟结果漂移
```

这条路线保留了 V3 的真实成交、费后价值和三路径决策语义，同时直接针对已观察到的
极端 R 与系统性 OOD。最不应做的是在旧 73,004 条标签上仅切换
`objective="huber"` 后直接发布；那只能抑制异常值梯度，不能恢复正确的经济标签。
