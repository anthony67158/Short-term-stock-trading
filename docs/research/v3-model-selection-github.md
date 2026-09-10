# V3 模型与策略 GitHub 方案调研

> 评估日期：2026-09-10
> 决策类型：技术选型与 POC 方案，不是生产采用结论
> 本轮范围：只调研，不修改训练代码、不重训、不发布模型

## 结论

**推荐：保留 V3 决策合同，先做三组并行 POC，不直接替换为 Transformer 或强化学习。**

1. **主基线：LightGBM 稳健多头模型**
   - `pFill`、`pWinGivenFill` 保留分类头。
   - `expectedNetR` 改用 Huber，并增加条件 Q10 Quantile 头。
   - 增加按交易日分组的 LambdaRank，只负责 Top3/Top5 排序。
2. **第一替代模型：CatBoost**
   - 使用 Huber/Quantile 与 YetiRank 做同口径 challenger。
   - 它是最值得验证的“换模型”方案，但只能由无泄漏 walk-forward 结果决定是否替换。
3. **第二替代模型：XGBoost**
   - 使用 Pseudo-Huber、Quantile 与 `rank:ndcg`。
   - 排序能力和文档最完整，可作为 CatBoost 的不同算法对照。
4. **结构增强：借鉴 Qlib DoubleEnsemble，不直接引入整个 Qlib。**
   - 复用其样本再加权、特征扰动筛选和多模型平均思想。
   - 当前官方实现的逐样本损失只支持 MSE，且特征抽样含随机过程，不应原样进入生产。

**暂不采用：** Qlib TRA/HIST、TabM、AutoGluon、TabPFN、FinRL、TimesFM、Chronos。
其中 TabM 可进入第二阶段研究；其余要么问题不匹配，要么运行/许可证/可解释性不满足当前生产边界。

置信度：**中高**。仓库和实现证据充分，但尚未在修复后的 V3 数据上运行同口径 POC。

## 决策简报

- **业务目标：** 每个交易日从全市场候选及现价/回踩/突破路径中，找出费后正期望且可执行的 Top3/Top5。
- **当前边界：** 87 维表格特征，约 73,004 个候选、37,516 个成交路径、124 个交易日。
- **当前问题：**
  - 历史 R 标签出现 `-504R ~ +361R`，存在风险分母污染。
  - 线上 31 个候选中 30 个 OOD，存在训练/推理特征分布不一致。
  - 当前 L2 回归和统一残差下界容易被极值污染。
- **必须具备：**
  - 支持分类、稳健回归、条件尾部估计或排序。
  - 可执行 purged/embargo walk-forward。
  - CPU 批量推理，240 条路径内低延迟。
  - 自托管，可每日在 GitHub Actions 重训。
  - 输出不能冒充概率或费后 R；必须保留校准与动作价值合同。
- **非目标：**
  - 不做券商自动交易。
  - 不用强化学习绕过现金、费用、T+1 和风险约束。
  - 不把通用时间序列预测直接当交易动作。
- **立即淘汰条件：**
  - 非商业或不明确许可证。
  - 依赖托管推理或生产登录令牌。
  - 需要大规模 GPU 才能满足日常训练/推理。
  - 无法按交易日和标签区间消除泄漏。

## 候选漏斗

| 候选 | 固定版本 | 阶段 | 结论 | 主要原因 |
|---|---|---|---|---|
| LightGBM | `7d3d1d8` | POC | **POC 主基线** | 已在项目使用；原生 Huber/L1/Quantile/LambdaRank；迁移成本最低 |
| CatBoost | `88b87b2` | POC | **POC 第一替代** | Huber/Quantile/YetiRank；CPU/GPU 均可；测试与发布成熟 |
| XGBoost | `49530df` | POC | **POC 第二替代** | Pseudo-Huber/Quantile/LambdaMART；分组排序文档完整 |
| Qlib DoubleEnsemble | `79633dd` | Evidence | **REFERENCE ONLY** | 金融噪声场景匹配，但官方代码只实现 MSE 样本损失 |
| Qlib TRA/HIST | `79633dd` | Discovery | **后续 POC** | 针对市场非平稳，但要求序列数据、PyTorch 与更复杂训练 |
| TabM | `28e47ae` | Evidence | **后续 POC** | TabReD 漂移基准表现有吸引力，但仓库无 CI/测试，且推理慢于 GBDT |
| AutoGluon | `7dc75f9` | Discovery | **REFERENCE ONLY** | 可做离线 bake-off，默认 AutoML 流程不保证金融时序无泄漏 |
| skfolio CPCV | `085485b` | Evidence | **REFERENCE ONLY** | 适合验证框架，不是 V3 预测模型；固定观测数 purge 不等于事件区间 purge |
| mlfinpy | `89511cc` | Evidence | **REFERENCE ONLY** | triple-barrier 与 purged CV 可借鉴；维护和工程证据弱于 skfolio |
| mlfinlab | `79dcc71` | Discovery | **REJECT** | 自定义商业许可，不适合直接复用 |
| TabPFN | `35e7045` | Discovery | **REJECT** | 默认权重非商业；CI 需登录令牌；CPU 大样本慢 |
| FinRL | `2334a5f` | Discovery | **REJECT** | 强化学习目标与当前路径级动作价值监督不匹配 |
| TimesFM / Chronos | 当前主分支 | Discovery | **REJECT** | 通用序列预测，不直接解决横截面路径排序、成交和费用条件概率 |

## 静态证据评分

> 分数只衡量仓库质量与本项目适配度，不代表策略收益。尚未跑本项目 POC，因此最高推荐等级为 `POC`。

| 方案 | 适配 | 实现/测试 | 维护/安全 | 集成成本 | 总分 | 建议 |
|---|---:|---:|---:|---:|---:|---|
| LightGBM 稳健多头 + Ranker | 18/20 | 25/26 | 30/34 | 18/20 | **91/100** | POC 主基线 |
| CatBoost 多头 + YetiRank | 17/20 | 25/26 | 31/34 | 14/20 | **87/100** | POC 第一替代 |
| XGBoost 多头 + LambdaMART | 17/20 | 25/26 | 31/34 | 13/20 | **86/100** | POC 第二替代 |
| Qlib DoubleEnsemble 思路 | 18/20 | 17/26 | 24/34 | 11/20 | **70/100** | 只移植思想 |
| TabM | 15/20 | 12/26 | 13/34 | 10/20 | **50/100** | 第二阶段研究 |

## 证据与判断

### LightGBM

`FACT`：官方参数同时支持 `huber`、`regression_l1`、`quantile`、`lambdarank`
和 `rank_xendcg`；LambdaRank 可设置 Top-K 截断与自定义 gain。

`FACT`：仓库有 54 个检测到的测试文件、15 个 CI 工作流、MIT 许可证，最新正式版
为 v4.7.0，固定提交在 2026-09-10 仍有维护。

`INFERENCE`：当前失败主要来自标签和特征合同，而不是 LightGBM 不够强。先用同一
库建立 clean-label 稳健基线，最容易隔离“数据修复”和“模型更换”的真实增益。

### CatBoost

`FACT`：核心枚举实现包含 MAE、Huber、Quantile、RMSEWithUncertainty、
YetiRank/YetiRankPairwise 和 QuerySoftMax。

`FACT`：Apache-2.0；169 个检测到的测试文件、12 个 CI 工作流；v1.2.10 于
2026-02 发布，固定提交为 2026-09-09。

`INFERENCE`：CatBoost 的 ordered boosting 和原生类别处理适合市场、板块、打法、
路径、时段这类低基数类别。要发挥优势，应在 POC 中输入原始类别，而不是只喂当前
one-hot；否则它与 LightGBM 的差异会被削弱。

### XGBoost

`FACT`：官方实现提供 `reg:pseudohubererror`、`reg:quantileerror` 和
`rank:ndcg`。LTR 文档明确要求用 `qid` 分组，并说明 Top-K pair 构造与小样本
策略。

`FACT`：Apache-2.0；402 个检测到的测试文件、17 个 CI 工作流；固定提交为
2026-09-09，v3.4.1 于 2026-08 发布。

`INFERENCE`：它最适合验证“按交易日分组直接优化 Top-K”是否优于点回归，但
rank score 只能用于排序，不能替代 `pFill`、`pWin` 或 expected R。

### Qlib DoubleEnsemble / TRA

`FACT`：DoubleEnsemble 以多个 LightGBM 子模型做训练轨迹样本再加权和扰动特征
筛选，目标是金融数据的低信噪比与不稳定性。

`FACT`：官方 `get_loss()` 只实现 MSE；特征选择使用随机 permutation 和 sampling。
直接复制会继续放大异常标签，并增加重训随机性。

`FACT`：TRA 支持 RNN/Transformer、多个潜在状态和路由，但依赖
`MTSDatasetH`、PyTorch、状态记忆及长训练配置。

`FACT`：Qlib 为 MIT，仓库活跃且有 CI；但 issue #2080 报告同一股票/日期的预测
会随 test segment 范围变化，说明不能把完整数据处理链无审计地引入。

`INFERENCE`：第一阶段只移植 DoubleEnsemble 的“多 seed + 困难样本重加权 +
特征稳定性投票”，并改成稳健损失；不引入 Qlib runtime。

### TabM

`FACT`：TabM 使用共享权重的并行 MLP ensemble，Apache-2.0；官方报告覆盖带时间
漂移的 TabReD，并支持大规模表格数据。

`FACT`：官方也明确它慢于 GBDT。统一证据采集未检测到 CI、测试、发布或安全策略，
仓库更接近论文复现实验包。

`INFERENCE`：73k × 87 的数据量足以做 TabM POC，但在没有证明树模型瓶颈前，
引入 PyTorch 和更高推理成本不合理。

## 推荐的 V3 POC 架构

### 共同数据与验证层

```text
标签 v2（计划风险 R）
  -> 训练/推理同源特征构造
  -> 按真实 [t0,t1] purge + embargo
  -> 固定三个以上连续 walk-forward 测试窗
  -> 同一数据并行训练各 challenger
```

任何模型比较之前必须先满足：

1. 100% 成熟成交标签声明 `riskBasis` 和费用版本。
2. 每个模型读取完全相同的候选、路径和特征快照。
3. 训练统计量、截尾点、校准器只在 fold 的训练/校准区间拟合。
4. 当日所有股票及三路径必须留在同一 partition。
5. 先解决当前 one-hot 与线上状态导致的系统性 OOD，再比较模型。

### 统一四头输出

```text
pFill                  = 是否成交
pWinGivenFill          = 成交后是否费后盈利
winPayoffR             = 盈利样本的 R 幅度
lossPayoffR            = 亏损样本的 R 幅度

expectedNetR =
  pWinGivenFill * winPayoffR
  + (1 - pWinGivenFill) * lossPayoffR

candidateUtility = pFill * expectedNetR
```

- 分类头用 isotonic 或 Platt 校准。
- payoff 头比较 Huber、L1/Pseudo-Huber。
- 条件 Q10 用 Quantile 模型直接预测，替代当前全局固定残差下界。
- Ranker 按 `tradeDate` 分组，只改变候选顺序，不改变概率和 R。

### 三组 POC

| POC | 模型 | 目的 |
|---|---|---|
| A | LightGBM Huber + Quantile + LambdaRank | 最低成本建立可信基线 |
| B | CatBoost Huber/Quantile + YetiRank | 验证 ordered boosting 与原始类别特征 |
| C | XGBoost Pseudo-Huber/Quantile + LambdaMART | 验证另一套稳健树与 Top-K 排序 |

Qlib-style ensemble 作为 A/B/C 的可选外层：3–5 个时间种子/子模型做平均与分散度，
不与某个底层库绑定。

## POC 通过门槛

| 测试 | 通过条件 |
|---|---|
| 标签审计 | 无接近零的隐含风险分母；极端 R 均能由真实跳空/跌停/费用解释 |
| 无泄漏 | `[t0,t1]` 与验证窗重叠的训练样本全部 purge；所有拟合统计量可追溯 |
| 校准 | pFill/pWin 的 Brier 与可靠性图不劣于 clean-label LightGBM |
| 排序 | 至少 3 个连续样本外窗口中，raw NetR@3/@5 和 bootstrap 下界优于基线 |
| 风险 | 最差日、最大回撤、ES10 不因平均收益改善而恶化 |
| 覆盖率 | 不能靠几乎永远不出信号获得高均值；同时报告正期望覆盖天数 |
| OOD | 正常交易日无系统性 UNKNOWN/单位错误；每次 OOD 能定位到具体字段 |
| 性能 | FC CPU 批量 240 路径 p95 < 100ms，模型总包体满足当前部署限制 |
| 重现性 | 固定数据、版本、种子重复三次，Top5 重合度和关键指标稳定 |

最终选择规则：

1. 先看 hard gate，不因平均分高而忽略泄漏、校准或尾部风险。
2. 若 CatBoost/XGBoost 未显著优于 LightGBM，则保留 LightGBM，避免无收益换栈。
3. 若多个模型各有优势，优先做离线 soft-vote；不要让多个模型在线争夺动作权。
4. 只有胜出的单一版本进入 `usagePolicy=DIRECT`；其余只保留离线评测，不做灰度决策。

## 强反方与决策变化条件

**最强反方：** 当前问题全部来自脏标签和特征错位，任何模型比较都可能只是在比较谁
更能掩盖数据错误。这个反方成立，因此 POC 必须在标签 v2 与同源特征完成后开始。

**结论会改变的条件：**

- 若 clean-label LightGBM 已让连续 walk-forward 的 Top5 下界稳定为正，CatBoost
  和 XGBoost 无显著增益，则不换模型。
- 若 CatBoost 在相同数据上稳定改善校准、Top5 下界与 OOD 鲁棒性，且 CPU 延迟达标，
  则替换回归/排序头。
- 若树模型全部在市场切换窗口明显失效，而 TabM 在严格 purged 测试中稳定胜出，
  再进入 TabM 第二阶段 POC。
- 在没有更多独立交易日之前，不采用 TRA/Transformer/RL 作为生产核心。

## 2026-09-10 最终生产选择

**ADOPT：LightGBM 动作价值头 + CatBoost YetiRankPairwise 排序头。**

- `FACT`：V4 三种子复验中，LightGBM 动作价值 Top5 均值为 `+0.026R`；
  CatBoost Ranker Top5 均值为 `+0.158R`，是已测排序器中最高。
- `FACT`：LightGBM sklearn 接口接受非负 `sample_weight`，可在不改变线上
  特征合同的前提下处理类别不平衡和困难样本。
- `FACT`：CatBoost `fit` 支持 `group_id`，本项目按交易日形成 query，并已在
  72,847 条真实 V4 成熟样本上执行三折 POC。
- `INFERENCE`：正负样本不做简单复制扩增。当前采用类别总权重平衡、近期
  权重、打法/路径逆频率权重和高公式分失败样本加权，避免重复样本放大过拟合。
- `INFERENCE`：只借鉴 Qlib DoubleEnsemble 的困难样本重加权思想，不引入其
  runtime，也不沿用其 MSE 标签口径。

最大反方是最新样本外窗口仍为负，组合尚未证明稳定盈利。按用户要求，本轮将
其作为“当前最佳可回滚基准”直接上线，而不是把评测状态改成通过；后续每日
三折三种子回测继续暴露最差窗口、bootstrap 下界、Q10 覆盖和相对常数基线
技能分。

## 来源

- [LightGBM 参数与目标函数](https://github.com/lightgbm-org/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/docs/Parameters.rst)
- [LightGBM LambdaRank 示例](https://github.com/lightgbm-org/LightGBM/tree/7d3d1d829981fc670629f63f00e11ce25d6624f5/examples/lambdarank)
- [LightGBM sklearn 权重接口](https://github.com/microsoft/LightGBM/blob/7d3d1d829981fc670629f63f00e11ce25d6624f5/python-package/lightgbm/sklearn.py)
- [CatBoost 损失与排序枚举](https://github.com/catboost/catboost/blob/88b87b2c5136ebe0b132c7d4d7f7bbef7710ce6f/catboost/private/libs/options/enums.h)
- [CatBoost Python 排序接口](https://github.com/catboost/catboost/blob/5dbb7346bc5b75e1a6c9b6578a90454f418bd2d3/catboost/python-package/catboost/core.py)
- [XGBoost 参数](https://github.com/dmlc/xgboost/blob/49530df058646d9c67ef47108e9a0b1eb3e164bf/doc/parameter.rst)
- [XGBoost Learning to Rank](https://github.com/dmlc/xgboost/blob/49530df058646d9c67ef47108e9a0b1eb3e164bf/doc/tutorials/learning_to_rank.rst)
- [Qlib DoubleEnsemble](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/qlib/contrib/model/double_ensemble.py)
- [Qlib TRA](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/qlib/contrib/model/pytorch_tra.py)
- [Qlib issue #2080](https://github.com/microsoft/qlib/issues/2080)
- [TabM](https://github.com/yandex-research/tabm/tree/28e47ae301c92ec37787dde1ce923a0793f405b4)
- [skfolio CombinatorialPurgedCV](https://github.com/skfolio/skfolio/blob/085485b0f35576c1b36b4c4253cb7b944fee0c6f/src/skfolio/model_selection/_combinatorial.py)
- [TabPFN 运行与许可证限制](https://github.com/PriorLabs/TabPFN/blob/35e7045e022dcda57446cdb4cdc864cb2c631b76/README.md)
- [FinRL 定位](https://github.com/AI4Finance-Foundation/FinRL/blob/2334a5fe6d30629157f13c3b0319e1637e15e123/README.md)
- 详细标签、验证与 OOD 方案：
  [v3-robust-training-strategies.md](./v3-robust-training-strategies.md)
