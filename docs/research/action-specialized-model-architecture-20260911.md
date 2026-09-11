# V3 动作专用模型与开源方案调研

评估日期：2026-09-11
决策类型：架构调研与 POC 建议

## 结论

可以按业务状态拆模型，但不应把买入、加仓、减仓、止损、止盈和复核做成
六个互不相关的分类器。推荐采用：

1. 一个共享市场与个股表征层。
2. 买入、持仓边际价值、退出时机三个任务头。
3. 一个只判断“是否需要重新评估”的复核头。
4. 一个统一的费后动作价值仲裁器。
5. 独立于模型的 T+1、现金、仓位、费用和硬止损规则层。

当前最值得借鉴的是 Qlib 的时序路由思想和 LibMTL 的 MMoE/PLE 多任务结构；
不建议直接引入完整交易框架或让强化学习策略接管生产动作。

## Decision brief

- 业务结果：提高短线动作选择的费后净期望，减少错过有效买入/加仓机会，
  同时不放松账户风险和退出纪律。
- 用户流程：用户只核对统一动作指令并记录真实成交。
- 当前系统：V3 统一评估现价、回踩、突破路径，再由账户和持仓策略选择
  `BUY/ADD/HOLD/REDUCE/EXIT`。
- 技术问题：不同动作的样本分布、标签和风险不对称，单一模型可能互相干扰；
  完全独立模型又会产生不可比较、互相冲突的分数。
- 必须具备：时间防泄漏、费后标签、T+1、动作可行性、概率校准、统一 R 口径、
  OOF/走前验证、版本化回滚。
- 非目标：自动下单、LLM 决定动作、用固定止损替换现有硬风控、直接上线 RL。
- 运行边界：Python 3.11 量化服务；Node 决策服务；OSS 模型热更新；FC/EAS。
- 数据边界：只使用决策时可获得的数据；真实账户数据不得进入公开样本。
- 许可证偏好：MIT/Apache-2.0；LGPL 组件只考虑独立服务或设计参考。
- 验收：新头必须在独立时间窗改善自身指标，并通过整体净R、下界、回撤、
  覆盖率、延迟和账户回放门禁。
- 立即淘汰：未来信息泄漏、动作分数不同量纲、不能表达 T+1/费用、用模型覆盖
  硬止损、只提供 notebook 演示而无可验证实现。

## GitHub 候选漏斗

| 候选 | 固定版本 | 结果 | 原因 |
|---|---|---|---|
| microsoft/qlib | `79633dd` | POC / 参考实现 | TRA 动态路由、滚动训练、嵌套决策和回测最接近需求 |
| median-research-group/LibMTL | `4336804` | 参考实现 | MMoE/PLE 展示共享专家与任务专用门控，但不是金融实现 |
| tensortrade-org/tensortrade | `d58afba` | POC / 参考实现 | 动作、奖励、风控订单、OMS 解耦清晰；领域和依赖仍需改造 |
| nautechsystems/nautilus_trader | `30d8848` | 执行层参考 | 执行、风控、回测工程质量高，但不是预测模型且 LGPL/集成成本高 |
| AI4Finance-Foundation/FinRL | `2334a5f` | 参考实现 | 有多种 RL 算法和股票环境，但项目明确定位研究/教学 |
| AI4Finance-Foundation/FinRL-Trading | `e65d6f0` | 暂不采用 | 权重接口理念合适，但缺 CI/测试且存在基础方法缺失问题 |
| TradeMaster-NTU/TradeMaster | `1747cc1` | 暂不采用 | 任务拆分丰富，但依赖陈旧、无 CI，且有训练代码缺失问题 |
| DLR-RM/stable-baselines3 | 当前主分支 | 仅算法依赖候选 | 通用 RL 实现，不提供交易标签、执行约束或费后价值合同 |
| ray-project/ray/RLlib | 当前主分支 | 暂不采用 | 多策略能力强，但对当前单 FC 推理链过重 |
| TauricResearch/TradingAgents | 当前主分支 | 淘汰 | LLM 多代理讨论不能替代可校准的数值动作价值 |

## 证据比较

| 项目 | 场景适配 | 实现与测试 | 维护与许可 | 主要风险 | 建议 |
|---|---|---|---|---|---|
| Qlib | 高 | 277 个核心文件、44 个测试、6 个 CI workflow | 活跃；MIT | 框架较重，现成策略不是 A 股做 T 合同 | 借鉴 TRA、滚动训练和嵌套决策；先 POC |
| LibMTL | 中 | 含 MMoE、PLE、8 类架构与多任务优化 | 2025 有更新；MIT | PLE 实现偏视觉/ResNet，金融数据需自建适配层 | 只复用架构思想或少量代码 |
| TensorTrade | 中 | 92 个测试；动作、奖励、OMS 可组合 | 2026 恢复发布；Apache-2.0 | 历史依赖迁移多，默认动作与 A 股规则不同 | 参考环境接口和仿真测试 |
| NautilusTrader | 低（模型）/高（执行） | 388 个测试、完整 CI/安全链 | 高频维护；LGPL-3.0 | Rust 引擎和现有 Node/FC 账本重叠，迁移成本高 | 不用于模型；执行仿真可单独 POC |
| FinRL | 中 | 有 PPO/SAC/TD3 等和股票环境，测试覆盖有限 | 活跃；MIT | README 明确旧仓库偏教学；账户与动作语义过粗 | 仅作 RL 基线 |
| FinRL-X | 中高 | 权重管线清晰，但未检测到 CI/测试 | 2026 v1.0；Apache-2.0 | 已有缺失基础方法、安装依赖和安全 Issue | 等工程质量稳定后再评估 |
| TradeMaster | 中 | 多任务目录完整，但未检测到 CI | 最后代码更新偏旧；Apache-2.0 | Ray 1.13/Gym 老依赖，Issue 报告训练代码缺失 | 只参考任务拆分 |

按 100 分加权 rubric 评估“作为本项目参考/POC 依赖”的结果：

| 候选 | 场景 | 实现 | 测试 | 维护 | 运维 | 安全 | 集成 | 治理 | 文档 | 热度 | 总分 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Qlib | 16.0 | 14.0 | 9.6 | 9.6 | 7.2 | 8.0 | 6.4 | 3.6 | 4.0 | 2.0 | **80.4** |
| TensorTrade | 12.0 | 11.2 | 9.6 | 7.2 | 4.8 | 4.0 | 6.4 | 3.6 | 3.2 | 1.6 | **63.6** |
| LibMTL | 12.0 | 11.2 | 7.2 | 7.2 | 2.4 | 4.0 | 6.4 | 2.4 | 3.2 | 1.2 | **57.2** |

NautilusTrader 的通用工程质量高，但因模型场景不匹配和 LGPL 集成边界不进入
本次模型依赖排名。FinRL、FinRL-X、TradeMaster 已在硬门禁阶段因生产定位或
可复现性不足排除，不用总分掩盖硬缺陷。

## 关键源码证据

### Qlib

- TRA 使用历史预测误差和隐表示，通过路由器选择多个 predictor，证明
  “共享表征 + 状态路由专家”有成熟实现：
  [TRA model](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/examples/benchmarks/TRA/src/model.py#L475-L532)。
- QlibRL 将 simulator、state interpreter、action interpreter、reward 拆开，
  可在同一环境训练不同策略：
  [QlibRL framework](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/docs/component/rl/framework.rst#L14-L48)。
- 嵌套决策允许组合级策略和执行级策略使用不同频率：
  [nested decision execution](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/examples/nested_decision_execution/README.md#L1-L30)。
- MIT；最新正式版证据为
  [v0.9.7](https://github.com/microsoft/qlib/releases/tag/v0.9.7)。

### LibMTL

- MMoE 为每个任务设置独立 gate，在共享 experts 上形成不同组合：
  [MMoE](https://github.com/median-research-group/LibMTL/blob/4336804847eaa5e0b924b743d76beec7ac3fdc97/LibMTL/architecture/MMoE.py#L8-L43)。
- PLE 同时保留共享与任务专用 experts：
  [PLE](https://github.com/median-research-group/LibMTL/blob/4336804847eaa5e0b924b743d76beec7ac3fdc97/LibMTL/architecture/PLE.py#L8-L125)。
- MIT；但官方示例集中在视觉、分子和 NLP，不包含交易成本、T+1 或动作价值。

### FinRL / FinRL-X

- FinRL 股票环境用一个连续动作向量同时表达买卖，并在环境中处理现金和手续费，
  不是按动作独立建模：
  [StockTradingEnv](https://github.com/AI4Finance-Foundation/FinRL/blob/2334a5fe6d30629157f13c3b0319e1637e15e123/finrl/meta/env_stock_trading/env_stocktrading.py#L19-L71)、
  [buy/sell](https://github.com/AI4Finance-Foundation/FinRL/blob/2334a5fe6d30629157f13c3b0319e1637e15e123/finrl/meta/env_stock_trading/env_stocktrading.py#L113-L224)。
- FinRL 的 A2C/DDPG/PPO/SAC/TD3 都由同一环境和动作空间驱动：
  [model registry](https://github.com/AI4Finance-Foundation/FinRL/blob/2334a5fe6d30629157f13c3b0319e1637e15e123/finrl/agents/stablebaselines3/models.py#L9-L26)。
- FinRL README 明确旧仓库面向教育和研究，生产方向迁到 FinRL-X：
  [FinRL README](https://github.com/AI4Finance-Foundation/FinRL/blob/2334a5fe6d30629157f13c3b0319e1637e15e123/README.md)。
- FinRL-X 使用统一目标权重作为选股、配置、择时和风控之间的合同：
  [weight-centric architecture](https://github.com/AI4Finance-Foundation/FinRL-Trading/blob/e65d6f0483ead7d2ef4a5fc940cdf960392a25c1/README.md#L24-L61)。
- 但 FinRL-X 当前存在
  [缺失 apply_risk_limits](https://github.com/AI4Finance-Foundation/FinRL-Trading/issues/90)
  和 [缺失 create_strategy](https://github.com/AI4Finance-Foundation/FinRL-Trading/issues/88)，
  且仓库未检测到常规测试/CI，不能作为生产依赖。

### TradeMaster

- 仓库按 algorithmic trading、portfolio management、order execution、HFT
  分任务，适合作为“按问题拆模型”参考。
- 其单资产环境仍将动作编码为一个离散仓位变化：
  [action space](https://github.com/TradeMaster-NTU/TradeMaster/blob/1747cc18db3fe2639af12defc80e138c51a625c0/trademaster/environments/algorithmic_trading/environment.py#L19-L65)。
- 依赖仍固定 `ray[rllib]==1.13.0`、同时包含 Gym/Gymnasium：
  [requirements](https://github.com/TradeMaster-NTU/TradeMaster/blob/1747cc18db3fe2639af12defc80e138c51a625c0/requirements.txt#L18-L25)；
  并有 [训练代码缺失 Issue](https://github.com/TradeMaster-NTU/TradeMaster/issues/219)。

### TensorTrade

- `ActionScheme` 将模型动作转换为订单，和奖励、环境、OMS 解耦：
  [action interface](https://github.com/tensortrade-org/tensortrade/blob/d58afba23deb1fded39793203b7997c3990bb032/tensortrade/env/default/actions.py#L24-L114)。
- `ManagedRiskOrders` 把方向、仓位、止损和止盈组合成动作空间：
  [managed risk actions](https://github.com/tensortrade-org/tensortrade/blob/d58afba23deb1fded39793203b7997c3990bb032/tensortrade/env/default/actions.py#L286-L398)。
- 奖励函数可独立替换，但仓库自己的实验也显示手续费可使策略由盈利转亏：
  [reward schemes](https://github.com/tensortrade-org/tensortrade/blob/d58afba23deb1fded39793203b7997c3990bb032/tensortrade/env/default/rewards.py#L36-L75)、
  [README research findings](https://github.com/tensortrade-org/tensortrade/blob/d58afba23deb1fded39793203b7997c3990bb032/README.md)。
- Apache-2.0、测试较多，但仍有
  [NaN 被静默转为 0](https://github.com/tensortrade-org/tensortrade/issues/501)
  等数据语义问题。

### NautilusTrader

- 风控引擎明确位于策略和执行之间，负责订单验证、余额、仓位和交易状态：
  [RiskEngine](https://github.com/nautechsystems/nautilus_trader/blob/30d88481852a914d07f91104945e8e7e95234e2d/crates/risk/src/engine/mod.rs#L94-L112)。
- 条件单和订单模拟器订阅报价、成交与订单事件：
  [OrderEmulator](https://github.com/nautechsystems/nautilus_trader/blob/30d88481852a914d07f91104945e8e7e95234e2d/crates/execution/src/order_emulator/emulator.rs#L59-L107)。
- 工程证据最强，但 LGPL-3.0、Rust 运行时和现有账本重叠，适合作为执行测试
  参考，不适合为动作模型引入。

## 推荐架构

### 1. 买入模型

适用状态：未持仓。
候选动作：`BUY_NOW / WATCH_PULLBACK / WATCH_BREAKOUT / SKIP`。
预测目标：路径成交概率、成交后盈利概率、胜负 R、Q10、1/3/5 日净R。
复用：现有 V3 三路径模型。

### 2. 持仓边际价值模型

适用状态：已持仓。
候选动作：`ADD / HOLD / REDUCE / EXIT`。
模型不直接输出中文动作，而是输出每个动作相对继续持有的边际价值：

```text
deltaValue(action) = E[netR | action] - E[netR | HOLD]
```

加仓必须加入成本价、已有仓位、今日可卖批次、剩余现金、开放风险和加仓后
止损损失；减仓与退出必须计入避免损失和放弃上涨的机会成本。

### 3. 退出时机模型

止盈、普通止损、减仓和退出共享一个“继续持有 vs 分段退出”的生存/尾部风险头，
预测：

- 下一观察窗触发尾部损失的概率；
- 继续持有的 MFE/MAE；
- 立即退出、减仓、延迟退出的费后净R；
- 达到目标价前先触发失效价的概率。

账本硬止损不是模型动作。它继续由确定性规则立即执行，模型只能处理非硬止损
的普通减仓、退出和止盈路径。

### 4. 复核模型

复核模型不输出买卖动作，只估计：

- 原决策是否仍有效；
- 触价后路径是否确认；
- 新证据是否足以改变动作；
- 继续等待一轮的价值。

达到复核条件后仍调用同一套动作价值头，避免“初始模型买入、复核模型卖出”
但两个分数无法比较。

### 5. 统一仲裁器

所有头必须输出统一合同：

```text
action
feasible
pFill
pSuccess
gainR
lossR
q10R
expectedNetR
uncertainty
horizon
modelVersion
```

服务端再按账户状态屏蔽非法动作，并在同一费后 R 量纲比较剩余动作。任何模型
都不能覆盖 T+1、现金、整手、止损、仓位和账户熔断。

## 为什么不采用六个独立模型

1. 买入和加仓共享标的上涨逻辑，但加仓标签必须是相对继续持有的增量价值。
2. 减仓、止盈和退出是同一个最优停止问题，拆开后容易同时给出高分。
3. 硬止损是约束，不是预测任务；学习化会在分布外行情中失效。
4. 复核是状态更新，不是新的交易人格；它必须复用统一动作价值。
5. 独立模型的概率和 R 值通常不可直接比较，会破坏当前唯一动作输出。

## 推荐实施顺序

1. 先保留 V3 买入模型不变。
2. 新增持仓反事实数据集，对每个快照同时结算
   `ADD/HOLD/REDUCE/EXIT`，优先解决选择偏差。
3. 用 LightGBM 建共享基线和动作残差头；样本不足时回退共享头。
4. 样本达到至少 10 万个成熟持仓快照后，再 POC MMoE/PLE；当前规模不建议
   直接引入深度多任务框架。
5. 将退出时机建成独立的生存/尾部风险头，但继续由统一动作价值仲裁。
6. 复核只训练“原决策仍有效/需要重算”，不直接训练第二套买卖策略。
7. 所有新头先执行 purged walk-forward、三种子、账户级顺序回放和成员级晋级。

## POC 门槛

| 测试 | 通过条件 |
|---|---|
| 动作头自身 | Brier 至少改善 0.002；AUC 至少提高 0.01 |
| 动作价值 | 净R MAE 不恶化超过 5%，排序相关性提升 |
| 组合收益 | Top5 费后净R相对冠军最多下降 0.01R |
| 尾部 | 95% 下界 > 0，最大回撤不超过冠军 5% 或 0.05R |
| 覆盖 | 正期望覆盖率至少 2%，最多下降 5 个百分点 |
| 账户 | T+1、现金、手续费、未完成订单占用和熔断全部通过 |
| 稳定性 | 每个独立时间窗都通过，不允许只靠总体均值 |

## 最终建议

**采用“共享模型 + 状态/动作头 + 统一仲裁器”，不采用“每个动作一个完全独立
模型”。**

开源代码的使用方式：

- Qlib TRA、QlibRL：`POC`，借鉴路由和多频决策。
- LibMTL MMoE/PLE：`REFERENCE ONLY`，借鉴共享/专用专家结构。
- TensorTrade：`REFERENCE ONLY`，借鉴环境、动作、奖励接口。
- NautilusTrader：`REFERENCE ONLY`，借鉴执行和风险测试。
- FinRL、FinRL-X、TradeMaster：当前不作为生产依赖。

最强反方是：统一模型可能继续产生动作间负迁移。改变结论的条件是，独立动作
模型在相同账户级 walk-forward 中持续提高净R下界、且不会产生冲突动作。
在此之前，共享表征和统一价值量纲比模型数量更重要。
