# 100 元封顶的开源时序基础模型完整训练方案

日期：2026-09-17  
状态：执行中  
预算：人民币 100 元硬上限  
范围：全市场 A 股、未来 5 个可交易日费后收益分布、人工成交工作流

关联文档：

- [A 股五日方向概率与校准收益区间模型研究](probabilistic-return-model-research-2026-09-17.md)
- [模型重训方案](model-retraining-plan.md)
- [实施记录](IMPLEMENTATION.md)

## 0. 执行进度

更新时间：2026-09-17

- [x] 1.1 定义实验、数据、模型来源、五折、三种子、预算和发布契约；
- [x] 1.2 实现规范化序列化、稳定 `experimentId` 和 `configHash`；
- [x] 1.3 实现不可变 `experiment.json` 写入、续跑一致性和篡改校验；
- [x] 1.4 增加 5 项契约测试并通过 Ruff；
- [ ] 1.5 Task 2 封存数据后写入真实 hash，生成最终 `experiment.json`；
- [ ] 2.1 构建 60–120 日点时序列；
- [ ] 2.2 构建五日费后收益、方向、成交与成交比例标签；
- [ ] 2.3 完成 purge/embargo、抽样权重和全市场测试对账；
- [ ] 3.1 训练 CatBoost MultiQuantile 基线；
- [ ] 3.2 训练 XGBoost quantile 基线；
- [ ] 3.3 训练 LightGBM quantile 基线；
- [ ] 4.1 在免费 GPU 上运行 TTM、TimesFM、Chronos 固定筛选；
- [ ] 4.2 按预注册分数冻结唯一主候选；
- [ ] 5.1 实现轻量分布头和 checkpoint 恢复；
- [ ] 5.2 完成单折单种子 smoke test；
- [ ] 6.1 运行前四折三种子并冻结配置；
- [ ] 6.2 一次性运行第五确认折；
- [ ] 7.1 完成概率、区间、拒答和执行校准；
- [ ] 7.2 完成容量、持仓及 Agent 联合消融；
- [ ] 8.1 生成模型包、成本报告和发布判定。

## 1. 目标与边界

本方案使用开源预训练时序基础模型，通过冻结骨干、轻量微调和缓存固定表示，在
100 元付费算力上限内完成一次可复现的候选训练与完整验证。

“完整训练”定义为：

1. 冻结点时数据、标签、费用、执行规则和股票池；
2. 复跑冻结树模型与历史分布基线；
3. 在免费算力上筛选开源基础模型；
4. 只选择一个候选家族进入 5 折 expanding walk-forward；
5. 每折训练 3 个随机种子的可训练模块，形成完整 OOF；
6. 独立完成概率校准、收益区间校准、拒答、执行和容量评估；
7. 生成版本化模型包、成本台账、失败记录和发布判定；
8. 未通过全部门禁时明确输出 `UNAVAILABLE`，不替换生产指针。

“完整训练”不表示：

- 三个基础模型都进行 5 折 3 种子全量微调；
- 100 元必须花完；
- 训练完成即代表指标合格、可盈利或可上线；
- 为节省预算而删除测试折、降低门禁或重复查看最终确认集；
- 模型或 Agent 可以写账户、余额、持仓、成交和原 OSS 交易事实。

## 2. 核心决策

### 2.1 模型策略

采用“一个轻量主候选 + 两个固定教师 + 树模型基线”：

| 角色 | 模型 | 使用方式 | 进入完整 5 折 |
|---|---|---|---|
| 主候选 | IBM Granite TTM r2.1 | 冻结骨干，训练 channel-mix decoder 和分布头 | 是 |
| 固定教师 | TimesFM 2.5 200M | 零样本生成点预测和分位特征；不默认全量 LoRA | 否 |
| 固定教师 | Chronos-2 120M 或 28M small | 零样本生成多变量、协变量和分位特征 | 否 |
| 强基线 | CatBoost/XGBoost/LightGBM | 同标签、同折、全量表格训练 | 是 |

基础权重 revision 冻结为：

| 模型 | revision |
|---|---|
| TTM `90-30-ft-l1-r2.1` | `cd2ad2a54ba5531fbcf6ba3b7a763a6e14223680` |
| TimesFM 2.5 200M | `1d952420fba87f3c6dee4f240de0f1a0fbc790e3` |
| Chronos-2 120M | `29ec3766d36d6f73f0696f85560a422f50e8498c` |

默认选择 TTM 的原因：

- Apache-2.0 权重，模型从约 1M 参数起；
- 官方提供冻结骨干、channel-mix 和外生变量微调路径；
- 日频 r2.1 权重可直接试验；
- 5 折 3 种子的可训练部分足够小，适合免费 P100/T4 和低价 12–24GB GPU；
- 可以保留完整验证协议，而不是用单折大模型结果代替。

TimesFM 和 Chronos 只作为固定教师。其预测及固定表示可以一次生成、多次复用，
避免每折反复训练 120M–200M 参数模型。若 TTM 在开发折明确失败，可在最终确认集
开启前，把 TimesFM 2.5 LoRA 设为新的候选版本；此时必须重新登记实验，不得沿用
已查看过的确认集。

### 2.2 任务目标

基础模型不预测精确股价。最终候选输出：

```json
{
  "availability": "READY | UNAVAILABLE | STALE | FAILED",
  "horizon": "5_trading_days_after_fill",
  "pWin": 0.61,
  "pFill": 0.74,
  "expectedFillRatio": 0.68,
  "q05": -0.071,
  "q10": -0.043,
  "q25": -0.015,
  "q50": 0.008,
  "q75": 0.031,
  "q90": 0.057,
  "q95": 0.081,
  "interval80": [-0.048, 0.062],
  "abstentionReasons": []
}
```

可训练模块包括：

- 方向头：binary log loss，输出 `pWin`；
- 分位头：七个分位的 pinball loss；
- 执行头：`pFill`、完整成交概率和成交比例；
- 可选排序头：日期内机会排序；
- TTM channel-mix decoder：学习 OHLCV、波动、市场和行业通道关系。

不得把每日分位数直接相加成五日分位数。分布头直接学习 `r_net_5d`，或者从联合
轨迹样本计算五日累计收益后再取分位数。

### 2.3 算力策略

| 顺序 | 平台 | 用途 | 付费上限 |
|---|---|---|---:|
| 1 | 本机 CPU/MPS | 数据、树模型、校准、回测、报告 | 0 元 |
| 2 | Kaggle P100/T4 | 零样本教师、TTM 开发折和大部分正式折 | 0 元 |
| 3 | Google Colab Free | Kaggle 无卡或排队时的可恢复任务 | 0 元 |
| 4 | AutoDL 3090 24GB | 免费额度不足后的正式折补时 | 60 元 |
| 5 | Vast.ai | 仅公开市场数据的可中断补时备选 | 包含在 60 元内 |

AutoDL 仅在实时单价不高于 `1.32 元/小时` 时使用 3090。按该价格，付费 GPU
最多 `45` 小时，理论费用 `59.40 元`。若价格更高，不创建实例，改等免费额度或
选择满足显存要求的更低价实例。

Vast.ai 只有同时满足以下条件才可替代 AutoDL：

- verified datacenter host；
- 可靠性不低于 `99%`；
- 计算、磁盘和带宽合计价格低于 AutoDL；
- 任务支持每 15 分钟保存 checkpoint；
- 只上传公开市场数据和匿名证券 ID，不上传账户、持仓、成交、密钥或 Agent 私有证据。

## 3. 预算台账

### 3.1 硬预算

| 项目 | 上限 | 控制方式 |
|---|---:|---|
| 付费 GPU | 60 元 | AutoDL 3090 最多 45 小时；逐任务登记 |
| 持久存储 | 10 元 | 优先使用免费 20GB；仅保存代码、适配器和汇总 |
| 数据传输 | 5 元 | 数据分片压缩；不反复跨境传输 |
| 中断/失败重跑 | 15 元 | 只重跑有 checkpoint 的未完成任务 |
| 未分配应急金 | 10 元 | 不用于追加模型或临时调参 |
| **总计** | **100 元** | **不得超支** |

其中 60 元是可预先安排的有效 GPU 任务预算；15 元重试金只能恢复已登记任务。
即使发生中断，GPU 平台累计扣费也不得超过 75 元，总支出达到 90 元即停止。

数据和临时张量放实例本地高速盘；长期只保留数据 manifest、代码、adapter、OOF
预测、校准器和报告。不得长期保存三个基础模型的重复缓存。

### 3.2 预算状态机

| 累计支出 | 状态 | 允许动作 |
|---|---|---|
| `0–40` 元 | GREEN | 按登记计划执行 |
| `40–75` 元 | YELLOW | 禁止新增候选，只完成当前候选 |
| `75–90` 元 | ORANGE | 停止调参，只允许补齐 OOF、校准和报告 |
| `>=90` 元 | STOP | 立即停止付费实例，保留 10 元用于备份和意外账单 |
| `>100` 元 | INVALID | 本次方案执行失败，不得把结果标记为合规 |

每个云任务启动前必须写入：

```text
provider
gpu
unit_price
planned_hours
planned_cost
spent_before
remaining_budget
artifact_checkpoint
auto_stop_at
```

任一任务的 `planned_cost > remaining_budget - 10` 时禁止启动。训练脚本结束、异常
或达到时限后必须自动退出，实例随后关机。

## 4. 数据与切分

### 4.1 数据合同

必须包含：

- 全市场、含退市股票的点时日频数据；
- 价格、成交、复权、涨跌停、停牌和板块制度；
- 60–120 日历史序列；
- 市场、行业、风格、流动性和波动状态；
- `published_at/effective_at/as_of`；
- 冻结费用、滑点、冲击成本、部分成交和 T+1 规则；
- `r_net_5d`、`y_dir`、`y_fill` 和成交比例标签。

训练可采用按交易日分层的确定性样本压缩，但必须满足：

- 每个训练日都有样本；
- 按市值、板块、流动性和结果分层；
- 保存抽样概率并使用逆概率权重；
- 测试集、执行回测和容量评估仍覆盖全量股票；
- 抽样规则在查看测试结果前冻结。

主候选每折最多使用 `1,500,000` 个训练窗口。达到上限后增加数据不是合法调参项，
除非建立新实验版本。

### 4.2 五折结构

采用 5 折 expanding walk-forward：

```text
train -> probability/quantile calibration -> conformal/selection calibration -> test
```

要求：

- 每个测试窗不少于 63 个交易日；
- 标签边界至少 5 日 purge，并保留 5 日 embargo；
- 同一交易日所有股票必须位于同一分区；
- 第 5 折为一次性确认集；
- 前 4 折完成后冻结模型、超参数、校准方法和拒答阈值；
- 最终折开启后不得新增特征、改标签、改阈值或更换候选。

### 4.3 三种子定义

每折运行固定种子：

```text
17, 29, 43
```

三种子覆盖所有可训练参数：

- TTM decoder；
- 方向头；
- 分位头；
- 排序头；
- batch 顺序和 dropout。

冻结基础模型本身无随机训练过程，不需要重复下载或重复计算固定参数。三种子结果
全部保留，最终使用预注册的均值或等权集成，禁止只挑最好种子。

## 5. 分阶段训练路径

### 阶段 A：冻结协议与成本

执行：

1. 生成数据、标签、切分和费用 manifest；
2. 锁定模型仓库、commit、权重 revision、许可证和依赖；
3. 写入 100 元预算及任务时限；
4. 建立仓库外实验目录。

产物：

```text
~/.local/share/stock-platform/foundation-return-100rmb-v1/
  experiment.json
  data-manifest.json
  split-manifest.json
  model-sources.json
  cost-ledger.jsonl
```

准入条件：

- manifest hash 可复现；
- 数据泄漏审计通过；
- 支出为 0 元；
- 活动生产指针未改变。

### 阶段 B：冻结强基线

在本机完成：

- CatBoost `MultiQuantile`；
- XGBoost quantile；
- LightGBM quantile；
- 方向发生率、历史分位数和现有排序模型基线；
- beta/sigmoid/isotonic 与 CQR 的统一评估代码。

基线使用全量可执行样本。任何深度候选必须在同一折、同一股票池和同一费用场景下
比较，不能只与随机或零预测比较。

停止条件：

- 基线不能复现；
- 标签与执行模拟不一致；
- 发现未来数据或幸存者偏差。

### 阶段 C：免费零样本筛选

在 Kaggle 优先运行：

1. TTM r2.1；
2. TimesFM 2.5；
3. Chronos-2。

仅使用前两个开发折，固定同一批样本，最多消耗 24 个免费 GPU 小时。筛选指标为：

- WIS 与 80% 区间 coverage；
- Brier/log loss；
- RankIC；
- Top-k 费后执行收益；
- 推理吞吐、显存和磁盘占用。

模型排序使用预注册分数：

```text
score =
  0.30 * WIS_skill
  + 0.25 * Brier_skill
  + 0.20 * RankIC_skill
  + 0.25 * net_return_skill
```

任一单项出现明确负向灾难性结果时，不允许通过其他指标抵消。零样本结果只用于选择
主候选，不作为最终发布证据。

### 阶段 D：主候选轻量微调

默认训练 TTM r2.1：

- 冻结 backbone；
- 启用 channel-mix decoder；
- 加入独立方向、分位和执行头；
- 可训练参数不超过总参数的 `20%`，且不超过 `5M`；
- FP16，effective batch size 通过 gradient accumulation 达到 `256`；
- 最大 20 epoch，patience 3；
- 每 15 分钟保存 adapter、优化器和数据游标；
- 每折单种子付费时限不超过 2 小时。

如果 TimesFM 2.5 在开发折显著领先，允许使用 LoRA：

- `rank=8`，`alpha=16`，dropout `0.05`；
- 只适配 attention projection 和分布头；
- 不解冻完整 200M 参数；
- 同样受每折单种子 2 小时付费时限约束。

Chronos-2 默认保持冻结教师，不在本版本自研其完整训练路径。

### 阶段 E：完整 OOF

对唯一主候选执行 5 折 × 3 种子：

1. 前 4 折用于模型与校准方案冻结；
2. 第 5 折只运行一次已冻结配置；
3. 保存每只股票、每个日期、每个种子的 OOF；
4. 生成种子均值和离散度；
5. 全量测试样本不得抽样；
6. 所有失败、超时和被中断任务计入结果，不静默删除。

免费 GPU 顺序完成尽可能多的运行。付费 GPU 只补齐未完成的正式折，不用于并行
探索。预计付费需求 `20–45` GPU 小时，对应约 `26.40–59.40` 元。

### 阶段 F：校准、拒答与经济门禁

在本机完成：

- `pWin` 的 beta、sigmoid、isotonic 时间外校准；
- 分位 crossing 修复；
- split CQR、rolling CQR、ACI 对照；
- coverage、width、Winkler、WIS 和 risk-coverage；
- `pFill`、部分成交、费用、容量、T+1 和持仓回放；
- 模型单独与模型 + 已冻结 Agent 证据的同样本消融。

训练预算不购买新的 Agent 调用。Agent 联合评估只能使用决策时点已冻结、可追溯的
历史证据；独立前瞻 Agent 验收仍属于发布门禁，不得用离线回放替代。

### 阶段 G：最终确认与打包

第 5 折只评估冻结方案。最终模型包包含：

```text
status.json
model-card.md
experiment.json
data-manifest.json
split-manifest.json
base-model-revision.json
adapter.safetensors
heads.safetensors
calibrator.json
selection-policy.json
oof-predictions.parquet
metrics.json
cost-ledger.jsonl
checksums.json
```

大体积训练数据、基础模型重复权重和临时 optimizer state 不进入 Git。

## 6. 成功、失败与停止条件

### 6.1 统计门禁

必须同时满足：

- 80% 区间总体 coverage 为 `[78%, 82%]`；
- 主要分组 coverage 为 `[75%, 85%]`；
- WIS/Winkler 不差于冻结基线，至少一个显著改善；
- Brier skill 为正，Brier 和 log loss 改善的 95% block bootstrap 下界大于 0；
- ECE 总体建议 `<=0.03`，主要分组建议 `<=0.05`；
- risk-coverage 随拒答增强而改善；
- 三个种子的主要结论方向一致。

### 6.2 交易门禁

必须同时满足：

- Top-k 费后执行收益增量的 95% 下界大于 0；
- RankIC、概率、区间和费后收益方向一致；
- 主要年份、板块、流动性组无统计明确的负增量；
- 10/50/100/500 万容量场景通过；
- `pFill`、部分成交、T+1、费用和持仓语义一致；
- Agent 联合增量独立通过，不能由模型指标替代；
- 独立前瞻窗口成熟后仍通过发布门禁。

### 6.3 立即停止

任一情况触发停止：

- 累计支出达到 90 元；
- 出现未来数据、标签穿越、校准污染或幸存者偏差；
- 首个完整开发折在 WIS、Brier 和费后收益上均灾难性落后基线；
- 两次恢复后仍不能从 checkpoint 继续；
- 单任务预计费用超过剩余可用预算；
- 需要降低门禁、删除失败样本或查看确认集才能继续；
- 云端需要上传账户、持仓、交易事实或凭据。

预算耗尽但任务未完成时，结果为 `BUDGET_EXHAUSTED`，不是训练成功。模型保持
`UNAVAILABLE`，后续新增预算必须建立新实验版本。

## 7. 实施任务

### Task 1：冻结实验注册表

**说明：** 创建数据、切分、模型、依赖、种子、预算和门禁的不可变配置。

**验收：**

- [ ] 配置包含所有输入 hash、权重 revision 和预算上限；
- [ ] 第 5 折时间范围已冻结但结果未读取；
- [ ] 活动生产指针未改变。

**验证：**

- [ ] 配置 schema 测试通过；
- [ ] 同配置重复生成相同 experiment ID。

**预计文件：**

- `backend/src/platform_app/modules/experiments/foundation_return_contract.py`
- `backend/tests/test_foundation_return_contract.py`

**依赖：** 无  
**预计范围：** M

### Task 2：构建序列与五日费后标签

**说明：** 从点时市场数据生成 60–120 日序列、执行标签和确定性训练抽样。

**验收：**

- [ ] purge/embargo 和同日分组正确；
- [ ] 测试与回测覆盖全量股票；
- [ ] 未成交样本不被错误标为零收益。

**验证：**

- [ ] 数据泄漏和边界测试通过；
- [ ] manifest 行数、日期和 hash 对账。

**预计文件：**

- `backend/src/platform_app/modules/experiments/foundation_return_dataset.py`
- `backend/tests/test_foundation_return_dataset.py`

**依赖：** Task 1  
**预计范围：** M

### Task 3：冻结树模型与历史分布基线

**说明：** 在相同标签和切分上生成概率、分位、排序和费后基线。

**验收：**

- [ ] 三类 GBDT 至少各有一份完整 OOF；
- [ ] 指标和费用场景可复跑；
- [ ] 基线版本不可被候选训练覆盖。

**验证：**

- [ ] 基线测试和回测通过；
- [ ] OOF 无 train/test 重叠。

**预计文件：**

- `backend/src/platform_app/modules/experiments/probabilistic_baseline_runner.py`
- `backend/tests/test_probabilistic_baseline_runner.py`

**依赖：** Task 2  
**预计范围：** M

### Task 4：免费基础模型筛选

**说明：** 在相同开发折上比较 TTM、TimesFM 和 Chronos 的固定输出。

**验收：**

- [ ] 免费 GPU 使用不产生付费；
- [ ] 三个候选均记录成功或明确失败原因；
- [ ] 按预注册分数选择唯一主候选。

**验证：**

- [ ] Kaggle/Colab 产物 hash 回传并可本地读取；
- [ ] 候选选择不使用第 5 折。

**预计文件：**

- `backend/src/platform_app/modules/experiments/foundation_teacher_runner.py`
- `backend/tests/test_foundation_teacher_runner.py`

**依赖：** Task 2、Task 3  
**预计范围：** M

### Task 5：实现轻量分布微调

**说明：** 冻结骨干，训练方向、分位、执行头和允许的 adapter/decoder。

**验收：**

- [ ] 可训练参数数量符合上限；
- [ ] checkpoint 支持恢复；
- [ ] 单任务时间和费用上限自动执行。

**验证：**

- [ ] 小样本 smoke test；
- [ ] 单折单种子端到端训练和推理通过。

**预计文件：**

- `backend/src/platform_app/modules/experiments/foundation_return_runner.py`
- `backend/tests/test_foundation_return_runner.py`
- `backend/pyproject.toml`

**依赖：** Task 4  
**预计范围：** M

### Task 6：运行 5 折 3 种子 OOF

**说明：** 对唯一主候选生成完整 OOF、种子方差和失败记录。

**验收：**

- [ ] 15 个正式运行均有明确终态；
- [ ] 每折都有 3 个有效种子预测，否则训练状态为不完整；
- [ ] 第 5 折使用冻结配置；
- [ ] 累计付费不超过 90 元停止线。

**验证：**

- [ ] OOF 唯一键、行数、日期和股票池对账；
- [ ] 三种子指标与预测 hash 已保存。

**预计文件：**

- `backend/src/platform_app/modules/experiments/foundation_return_walk_forward.py`
- `backend/tests/test_foundation_return_walk_forward.py`

**依赖：** Task 5  
**预计范围：** M

### Task 7：校准、拒答和执行回测

**说明：** 完成概率、区间、选择性预测及真实业务语义评估。

**验收：**

- [ ] 校准器只读取历史已成熟标签；
- [ ] risk-coverage 和所有主要切片已报告；
- [ ] 费后、部分成交、容量和持仓回放完成。

**验证：**

- [ ] 校准与执行测试通过；
- [ ] 相同样本的基线和候选指标可直接比较。

**预计文件：**

- `backend/src/platform_app/modules/experiments/return_distribution_calibration.py`
- `backend/tests/test_return_distribution_calibration.py`

**依赖：** Task 3、Task 6  
**预计范围：** M

### Task 8：发布判定与归档

**说明：** 生成模型卡、成本报告、门禁结果和不可变候选包。

**验收：**

- [ ] 总支出不超过 100 元；
- [ ] 每项门禁都有证据或明确缺口；
- [ ] 未通过时状态为 `UNAVAILABLE`；
- [ ] 不修改生产活动指针。

**验证：**

- [ ] checksum、模型加载和离线推理测试通过；
- [ ] 仓库不存在权重、数据、密钥或账户原文。

**预计文件：**

- `backend/src/platform_app/modules/experiments/foundation_return_finalize.py`
- `backend/tests/test_foundation_return_finalize.py`
- `docs/rebuild/IMPLEMENTATION.md`

**依赖：** Task 7  
**预计范围：** S

## 8. 阶段检查点

### Checkpoint 1：Task 1–3

- [ ] 数据与标签无泄漏；
- [ ] 冻结基线可复跑；
- [ ] 支出为 0 元；
- [ ] 人工确认后才使用免费 GPU。

### Checkpoint 2：Task 4–5

- [ ] 唯一主候选已冻结；
- [ ] 单折较基线存在继续价值；
- [ ] 预计剩余任务可在预算内完成；
- [ ] 人工确认后才开启付费实例。

### Checkpoint 3：Task 6–8

- [ ] 完整 OOF、校准和交易评估完成；
- [ ] 成本台账与平台账单一致；
- [ ] 发布状态正确；
- [ ] 独立前瞻未成熟前不替换线上。

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 免费 GPU 不可用或中断 | 延长日历时间 | checkpoint、Kaggle/Colab 切换、45 小时付费兜底 |
| P100 不支持 BF16 | 训练不稳定或变慢 | 使用 FP16、loss scaling、较小 batch 和梯度累积 |
| 10M 级窗口推理耗时 | 超预算 | 流式分片、训练分层抽样、测试全量、固定表示只计算一次 |
| 预训练域与股票域差异 | 迁移无增量 | 树模型强基线、单折止损、允许最终保持 `UNAVAILABLE` |
| 社区金融权重数据不明 | 泄漏和许可证风险 | 仅使用 Amazon/Google/IBM 官方权重 |
| 云端数据泄漏 | 安全与合规风险 | 只上传公开市场数据和匿名 ID，账户数据永不离开受控环境 |
| 预算压力诱导降门禁 | 错误发布 | 预算和质量门禁独立；钱用完即停止，不改阈值 |

## 10. 最终执行原则

1. 100 元是硬成本上限，不是必须消耗的额度；
2. 免费算力影响完成时间，不改变完整验证要求；
3. 只允许一个基础模型家族进入完整微调；
4. 固定教师只计算一次，五折复用其时点安全输出；
5. 全量股票用于测试和回测，训练抽样必须可审计；
6. 第 5 折只开一次；
7. 统计合格不能替代费后、执行、容量、持仓和 Agent 门禁；
8. 训练完成但未达门禁时，正确结果是 `UNAVAILABLE`；
9. 本方案只产生只读模型证据，不自动下单、不写交易事实；
10. 后续实施和每次实际费用写入 `docs/rebuild/IMPLEMENTATION.md`。

## 11. 外部依据

- [IBM Granite TTM r2 模型卡](https://huggingface.co/ibm-granite/granite-timeseries-ttm-r2)
- [TimesFM 2.5 Apache-2.0 权重](https://huggingface.co/google/timesfm-2.5-200m-pytorch)
- [Chronos-2 Apache-2.0 权重](https://huggingface.co/amazon/chronos-2)
- [Kaggle GPU 使用说明](https://www.kaggle.com/docs/efficient-gpu-usage)
- [Google Colab 免费资源限制](https://research.google.com/colaboratory/faq.html)
- [AutoDL GPU 价格](https://www.autodl.com/)
- [AutoDL 文件存储计费](https://www.autodl.com/docs/fs/)
- [Vast.ai 实时 GPU 市场价格](https://vast.ai/pricing)
