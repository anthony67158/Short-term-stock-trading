# 多任务交易决策引擎改造方案

> 状态：Proposed
>
> 设计版本：`multi-task-trading-engine.v1`
>
> 最后更新：2026-09-11
>
> 适用范围：短线操盘台的选股、组合决策、执行评估、风险控制和触价复核
>
> 事实基线：`stock-dashboard@2147e37` 与 2026-09-11 工作区实现
>
> 替代目标：当前 V3 单一机会评分主链

## 0. 执行摘要

### 决定

将系统改造成四个任务域：

1. **选股**：发现并排序值得深查的股票和路径。
2. **组合**：比较买入、加仓、持有、减仓、退出的账户级边际价值。
3. **执行**：预测成交、滑点、等待成本和订单路径。
4. **风控**：预测尾部损失和退出风险，并执行确定性账户约束。

模型采用“**共享状态编码器 + 专家路由 + 任务头 + 统一动作价值仲裁器**”。
可以买入、加仓、减仓、止盈和退出使用不同任务头，但不能成为五套互不相关、
各自直接发号施令的模型。

### 关键边界

- **硬止损不使用模型**：价格触及账本硬止损时，确定性规则优先。
- **复核模型不决定买卖**：只判断原决策是否仍有效、是否需要立即重算。
- **所有动作必须换算成同一费后 R 量纲**，再由服务端统一选择唯一动作。
- **账户、持仓、成交、T+1、费用和执行计划继续由 Node 账本负责**。
- **LLM 继续只做解释**，不得修改动作、价格、手数和风险预算。
- 当前生产 V3 在新架构完整通过离线回放、测试账号和发布门禁前保持不变；
  持仓决策不做生产影子双轨，验收后一次性切换，保留版本级回滚。

### 开源结论

- 采用 Qlib TRA、LibMTL MMoE/PLE 的结构思想，不整套复制。
- d3rlpy、SCOPE-RL 只用于未来离线强化学习 POC。
- CausalML 只用于动作增量价值的研究验证。
- NautilusTrader、TensorTrade 只参考执行与仿真合同。
- 不直接采用 FinRL、FinRL-X、TradeMaster 或 LLM TradingAgents 作为生产决策器。

## 1. 问题定义

### 1.1 真正要解决的问题

表面问题是“不同动作是否应该使用不同模型”。真正问题是：

> 如何让不同交易阶段使用最适合的预测目标和数据，同时保证所有动作可以在同一
> 费后价值尺度上比较，并且不会突破账户、T+1、止损和真实成交约束。

### 1.2 当前状态

当前 V3 已经具备：

- 全市场候选召回；
- 现价、回踩、突破三条价格路径；
- `pFill`、`pWinGivenFill`、胜负 R、Q10 和排序头；
- 三种子 LightGBM/CatBoost 集成；
- `BUY/ADD/HOLD/REDUCE/EXIT` 动作投影；
- 账户预算、T+1、费用、仓位和熔断；
- 触价后约 60 秒观察并重新执行 V3；
- 成熟反事实结果和市场数据归档；
- 成员级挑战者晋级和整体组合门禁。

当前核心差距：

| 维度 | 当前状态 | 目标状态 | 影响 |
|---|---|---|---|
| 任务边界 | 单股路径评分被买入、持仓和复核共同复用 | 四个任务域分别建模 | 不同动作标签混在同一预测语义中 |
| 持仓价值 | V3 分支主要用单路径净期望推导持有/退出 | 同时预测各动作相对 HOLD 的价值 | 加减仓与退出缺少真实反事实比较 |
| 执行 | `pFill` 与方向价值绑定在同一模型包 | 独立预测成交、滑点和等待成本 | 信号正确与能否成交无法独立优化 |
| 风险 | Q10 已存在，部分持仓逻辑仍含规则公式 | 学习尾部风险，规则负责硬约束 | 软风险和硬约束职责不完全清楚 |
| 复核 | 触价后重跑 V3 | 先判断决策稳定性，再重跑动作头 | 每次复核成本高，缺少“信息价值”度量 |
| 表征 | 120 维静态特征输入多个独立树模型 | 共享市场、个股、账户和事件表征 | 任务之间不能共享有效状态信息 |

### 1.3 已知证据

- 当前训练基线有 73,215 条成熟路径、37,544 条完整成交结果、126 个交易日。
- 当前 `pFill` 区分能力较强，但 `pWinGivenFill` 在部分窗口接近随机。
- 分打法/路径校准和 OOF 专家试验没有稳定达到 pWin 独立晋级门槛。
- 最近市场阶段中，不同打法和路径的收益分布明显漂移。
- 当前账户、T+1、执行计划、人工成交和熔断合同已有完整测试，应作为不可变边界。

### 1.4 关键未知项

| 未知项 | 影响 | 所需证据 | 默认动作 |
|---|---|---|---|
| 持仓快照数量及动作覆盖 | 决定能否训练 ADD/REDUCE/EXIT 头 | 按动作、日期、股票统计成熟样本 | 数据不足时维持规则策略 |
| 反事实标签可信度 | 决定模型是否学习真实动作增量 | 同一状态下多动作回放和费用校验 | 不使用只观察到的用户动作作因果标签 |
| 共享神经编码器是否优于树模型 | 决定是否引入 PyTorch/EAS | 同切分、同特征、同门禁 POC | 继续使用 LightGBM/CatBoost |
| 离线 RL 的行为策略概率 | 决定 OPE 是否可信 | 记录候选动作集与原策略概率 | 不进入离线 RL 发布链 |
| 复核头能否减少无价值重算 | 影响延迟和模型成本 | 触发事件后的决策变化率与避免损失 | 默认仍重跑完整动作模型 |

## 2. 目标与非目标

### 2.1 目标

1. 每个任务使用与其业务结果一致的标签和损失。
2. 所有合法动作输出可比较的费后净R、尾部风险和不确定性。
3. 共享表征减少重复训练，同时用任务头隔离负迁移。
4. 训练、回测、线上推理使用同一状态和动作合同。
5. 任一任务头失败时可局部降级，不污染其他任务。
6. 支持成员级晋级、整包验证和原子回滚。
7. 最终页面仍只展示一个动作，不增加用户决策负担。

### 2.2 非目标

1. 不让一个端到端 RL Agent 直接控制真实账户。
2. 不把硬止损、T+1、现金和仓位上限学习化。
3. 不为每个动作建立完全独立、分数不可比较的系统。
4. 不保留旧建议正文、旧公式分和旧 V3 内部 Schema 的永久兼容。
5. 不在生产个人账号执行有副作用的影子验证。
6. 不因开源项目拥有大量 Star 就直接引入其运行时。

## 3. 核心约束与不变量

| ID | 不变量 | 验证 |
|---|---|---|
| I-01 | 新增风险必须满足费后净期望大于 0 | 决策合同测试、账户级回放 |
| I-02 | 硬止损不等待模型或复核 | 风控 Harness |
| I-03 | 当日买入不可卖，卖出不得超过可卖量 | T+1 Harness |
| I-04 | 未完成买单占用现金，未完成卖单不释放现金 | 执行状态机测试 |
| I-05 | 同一状态只发布一个最终动作 | 决策一致性测试 |
| I-06 | LLM 不能修改动作、价格、手数和风险 | 输出白名单测试 |
| I-07 | 训练数据严格 point-in-time，标签区间必须 purge | 数据血缘和切分测试 |
| I-08 | 生产只加载 `DIRECT` 且完整校验的模型包 | Manifest 回读测试 |
| I-09 | 账户真实数据结构保持兼容 | 迁移回放 |
| I-10 | 新架构失败时可原子回滚到现役版本 | 发布演练 |

## 4. 当前状态与证据

### 4.0 开源证据说明

### 4.1 候选结论

| 项目 | 固定版本 | 可复用内容 | 结论 |
|---|---|---|---|
| microsoft/qlib | `79633dd` | TRA 路由、滚动训练、嵌套决策、回测 | POC / 参考实现 |
| median-research-group/LibMTL | `4336804` | MMoE、PLE、任务权重和梯度冲突处理 | 参考实现 |
| takuseno/d3rlpy | `38c34b6` | CQL、IQL、离线策略训练 | 后期 POC |
| hakuhodo-technologies/scope-rl | `b1c9e9f` | OPE、OPS、DR/IS 策略评估 | 后期参考；维护偏弱 |
| uber/causalml | `9a23278` | 多 treatment uplift、R/T/X/DR learner | 反事实动作价值 POC |
| sebp/scikit-survival | `7c56aba` | Cox、随机生存森林、时间依赖指标 | 退出建模参考，不直接依赖 |
| tensortrade-org/tensortrade | `d58afba` | Action/Reward/OMS/Stopper 解耦 | 仿真接口参考 |
| nautechsystems/nautilus_trader | `30d8848` | 确定性执行、风控、回放和对账 | 执行层参考 |
| AI4Finance-Foundation/FinRL | `2334a5f` | 股票 RL 环境、A2C/PPO/SAC/TD3 | 教学基线，不作生产依赖 |
| AI4Finance-Foundation/FinRL-Trading | `e65d6f0` | 权重型模块合同 | 暂不采用 |
| TradeMaster-NTU/TradeMaster | `1747cc1` | 按交易任务拆环境和 Agent | 暂不采用 |

### 4.2 可采用的设计证据

**Qlib**

- TRA 根据历史预测误差和隐状态路由到不同 predictor：
  [源码](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/examples/benchmarks/TRA/src/model.py#L475-L532)。
- QlibRL 将 simulator、state、action、reward 分离：
  [框架](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/docs/component/rl/framework.rst#L14-L48)。
- 支持不同频率的组合决策与订单执行：
  [嵌套决策](https://github.com/microsoft/qlib/blob/79633dd9506ea689e5400dea0197717b5b3d74b7/examples/nested_decision_execution/README.md#L1-L30)。
- MIT、存在测试/CI、2026 仍有提交；适合做研究编排和路由参考。

**LibMTL**

- MMoE 为每个任务设置独立 gate，在共享 experts 上形成任务专用表示：
  [MMoE](https://github.com/median-research-group/LibMTL/blob/4336804847eaa5e0b924b743d76beec7ac3fdc97/LibMTL/architecture/MMoE.py#L8-L43)。
- PLE 同时保留共享专家和任务专用专家：
  [PLE](https://github.com/median-research-group/LibMTL/blob/4336804847eaa5e0b924b743d76beec7ac3fdc97/LibMTL/architecture/PLE.py#L8-L125)。
- MIT；实现主要面向视觉编码器，应复用思想而不是直接绑定。

**离线 RL 与因果评估**

- d3rlpy 提供 CQL、IQL 等离线 RL：
  [仓库](https://github.com/takuseno/d3rlpy/tree/38c34b6f99fde82875e2ad81d1ba1f7a7da34137)。
  但 CQL 存在真实数据不收敛报告：
  [Issue #457](https://github.com/takuseno/d3rlpy/issues/457)。
- SCOPE-RL 提供离线策略评估和选择：
  [仓库](https://github.com/hakuhodo-technologies/scope-rl/tree/b1c9e9fbfddd924362160ec5e9f9f071abc7b7ea)。
  真实数据仍要求可靠的行为策略和轨迹合同，且项目自 2024 后维护较少。
- CausalML 提供多 treatment uplift 和 meta-learner：
  [仓库](https://github.com/uber/causalml/tree/9a2327811406240925e9b8c0ce16734a04da52d7)。
  适合研究 ADD/REDUCE 相对 HOLD 的异质处理效应，但不能在缺少 overlap 和
  propensity 的情况下把相关性当作因果。

**退出与执行**

- scikit-survival 提供成熟生存分析实现且 2026 仍持续发布：
  [仓库](https://github.com/sebp/scikit-survival/tree/7c56aba0a8b55f82dd92cac4df040e27f68d9e79)。
  其 GPL-3.0 不适合直接并入当前服务，方法可用于 POC 或自行实现离散 hazard。
- TensorTrade 将 ActionScheme、RewardScheme、OMS 分开，并提供止损/止盈订单：
  [动作接口](https://github.com/tensortrade-org/tensortrade/blob/d58afba23deb1fded39793203b7997c3990bb032/tensortrade/env/default/actions.py#L24-L114)、
  [ManagedRiskOrders](https://github.com/tensortrade-org/tensortrade/blob/d58afba23deb1fded39793203b7997c3990bb032/tensortrade/env/default/actions.py#L286-L398)。
- NautilusTrader 将风控作为策略与执行之间的确定性网关：
  [RiskEngine](https://github.com/nautechsystems/nautilus_trader/blob/30d88481852a914d07f91104945e8e7e95234e2d/crates/risk/src/engine/mod.rs#L94-L112)。
  工程质量高，但 LGPL-3.0、Rust 和现有 Node 账本边界使整体迁移成本过高。

### 4.3 明确不直接采用

- FinRL 旧仓库已明确定位教育和研究，且公开 Issue 暴露过账户对账、环境 API
  和数据一致性问题。
- FinRL-X 的权重接口方向正确，但当前仓库没有常规 CI/测试，且存在
  [缺失风控方法](https://github.com/AI4Finance-Foundation/FinRL-Trading/issues/90)
  与 [缺失策略工厂](https://github.com/AI4Finance-Foundation/FinRL-Trading/issues/88)。
- TradeMaster 依赖 `ray[rllib]==1.13.0` 和旧 Gym，且存在
  [训练代码缺失](https://github.com/TradeMaster-NTU/TradeMaster/issues/219)。
- TensorTrade 可用于环境 POC，但
  [NaN 被静默变为零](https://github.com/tensortrade-org/tensortrade/issues/501)
  与历史依赖迁移说明不能直接接管生产数据语义。
- LLM 多代理交易框架缺少可校准动作价值、账户硬约束和真实成交闭环，不进入
  数值决策链。

## 5. 备选方案与决策

| 方案 | 最强支持 | 最强反对 | 结论 |
|---|---|---|---|
| 共享编码器 + 路由/多头 + 统一仲裁 | 共享信息、隔离任务差异、动作价值可比较 | 数据和训练治理复杂，编码器变化影响全部头 | 采用 |
| 每个动作完全独立模型 | 任务边界直观，单头可单独迭代 | 分数不可比、样本碎片化、动作冲突 | 淘汰 |
| 单一端到端 RL 策略 | 可直接优化长期组合收益 | 仿真偏差、离线策略评估和安全解释不足 | 暂不采用 |
| 保持现有 V3 | 风险最低、已有生产验证 | 持仓动作标签和共享表征能力不足 | 作为迁移冠军 |

**决策**：采用共享编码器、多任务头和统一动作价值。当前 V3 保持生产冠军，
目标架构通过后一次性切换。

**最强反方**：当前成熟样本规模不足，复杂共享模型可能比树模型更易过拟合，
并产生任务负迁移。

**应对**：每个深度模型必须与树模型基线同场比较；共享编码器无稳定增益时，
保留四任务域和统一合同，但继续使用 LightGBM/CatBoost 多头。

**翻转条件**：若完全独立动作模型在相同账户级 walk-forward 中持续提高净R
下界、没有动作冲突且维护成本可接受，可放宽共享参数比例，但统一动作价值和
确定性风控不可取消。

## 6. 目标架构

```text
市场归档 / 实时行情 / 板块 / 资金 / 公告
                    |
                    v
            Decision State Builder
                    |
                    v
          Shared State Encoder v1
        /          |          |          \
       v           v          v           v
 Selection     Portfolio   Execution     Risk
   Heads         Heads       Heads        Heads
       \           |          |           /
        \          |          |          /
         +---- Action Value Normalizer ---+
                         |
                 Deterministic Router
                         |
                 Account Risk Gateway
                         |
                 One Decision Envelope
                         |
             Monitoring / Review / Execution
```

这里的“共享”是状态表征共享，不是所有任务共用同一标签；“路由”先由确定性
状态机限制合法动作，再由学习门控选择专家；“多头”输出各自指标，但最终必须
投影到统一动作价值。

## 7. 四个任务域

### 7.1 选股

职责：

- 从全市场召回合法候选；
- 为股票和三条价格路径计算横截面机会分；
- 输出候选排序和证据完整度；
- 不决定账户是否买入。

推荐模型：

- 近期阶段：LightGBM 多标签头 + CatBoost LambdaRank。
- 中期候选：Qlib TRA 风格的时序路由。
- 不采用：单个端到端 RL Agent 直接从全市场输出订单。

输出：

```text
selectionScore
routeScores[IMMEDIATE|PULLBACK|BREAKOUT]
expectedOpportunityR
evidenceCoverage
uncertainty
```

### 7.2 组合

职责：

- 对未持仓状态比较 `BUY` 与 `WAIT`；
- 对持仓状态比较 `ADD/HOLD/REDUCE/EXIT`；
- 计算行业、单股、总仓位和机会成本；
- 输出目标动作和目标风险，不直接提交订单。

推荐模型：

- 共享编码器；
- Entry Head；
- Add Marginal Value Head；
- Hold Continuation Head；
- Reduce/Exit Competing-Risk Head；
- 任务专用 gate，参考 MMoE/PLE。

关键定义：

```text
Q_buy    = 新建仓位后的费后价值
Q_add    = 加仓后的费后价值 - 继续持有价值
Q_hold   = 当前仓位继续持有的费后价值
Q_reduce = 减仓避免损失 - 放弃上涨 - 费用
Q_exit   = 清仓避免损失 - 放弃上涨 - 费用
```

加仓不能复用买入标签。买入回答“是否建立风险”，加仓回答“已有风险下再增加
一单位风险是否增值”。

### 7.3 执行

职责：

- 预测指定价格路径的成交概率、预计成交时间和滑点；
- 为买入、加仓、减仓、退出提供相同执行成本接口；
- 不决定方向，不管理账户真相。

推荐模型头：

- `pFill` 二分类；
- `timeToFill` 离散时间 hazard；
- `slippageBps` 分位数回归；
- `partialFillRatio` 回归；
- `adverseSelectionR` 回归。

执行模型输出进入动作价值：

```text
executableValue =
  pFill * directionalValue
  - commissionR
  - stampDutyR
  - transferFeeR
  - slippageR
  - waitingCostR
```

### 7.4 风控

职责分成两层。

确定性层：

- T+1；
- 现金与未完成订单占用；
- 单股、行业、总仓位；
- 账户熔断；
- 涨跌停和整手；
- 账本硬止损；
- 数据完整性和模型版本。

学习层：

- Q10/Q05；
- CVaR；
- 未来观察窗触发失效价的 hazard；
- 流动性枯竭和退出时间；
- 组合尾部相关性；
- 模型分布外和不确定性。

学习层只能缩小风险或提供动作价值输入，不能绕过确定性层。

## 8. 共享状态编码器

### 8.1 输入域

```text
MarketState
  市场广度、波动、涨跌停、风格、机会密度

SectorState
  板块阶段、资金、扩散、龙头/跟随关系

InstrumentState
  日线、5分钟路径、VWAP、波动、流动性、主力/小单

PathState
  现价/回踩/突破价格、止损、目标、ATR距离、有效期

PortfolioState
  持仓、成本、浮盈亏、可卖批次、现金、暴露、机会成本

ExecutionState
  时段、盘口、成交量、历史滑点、未完成订单

ReviewState
  原决策、触发原因、触发后60秒路径、证据变化
```

### 8.2 编码器结构

目标实现使用 PyTorch：

- 连续特征：稳健归一化 + MLP；
- 日线与分时序列：轻量 TCN 或 GRU；
- 类别特征：打法、路径、市场状态、板块阶段 embedding；
- 账户状态：独立 MLP；
- 缺失信息：显式 availability mask，不用零值冒充；
- 合并后形成 `sharedStateEmbedding`。

第一版不直接采用完整 LibMTL。实现项目内最小 MMoE：

- 共享专家：趋势、均值回归、催化、流动性、尾部风险；
- 每个任务头拥有独立 gate；
- gate 输入包含市场状态、持仓状态和路径；
- gate 只选择表示，不改变动作合法性；
- 使用 GradNorm 或 PCGrad 处理任务梯度冲突，先以固定权重作为基线。

### 8.3 为什么不继续只用树模型

树模型仍保留为强基线和回滚版本。共享编码器的价值必须通过以下证据证明：

- 同一状态在不同任务之间可复用；
- 新增动作头不需要复制全部特征工程；
- pWin、尾部风险和动作价值同时改善；
- 推理延迟和模型包大小可接受。

若以上任一项不成立，生产继续使用树模型多头，不因“主流架构”强行使用深度模型。

## 9. 路由与动作头

### 9.1 两级路由

第一级为确定性路由：

| 状态 | 合法动作 |
|---|---|
| 未持仓 | `WAIT/BUY` |
| 已持仓且可卖 | `ADD/HOLD/REDUCE/EXIT` |
| 已持仓且 T+1 锁定 | `ADD/HOLD/HOLD_LOCKED` |
| 硬止损且可卖 | `EXIT` |
| 硬止损且不可卖 | `HOLD_LOCKED` |
| 数据或模型失效 | 禁止新增风险；保留确定性退出 |

第二级为学习路由：

- 在合法动作内选择共享专家权重；
- 输出每个动作头的价值和不确定性；
- 禁止屏蔽硬风控动作；
- 路由置信不足时退回共享专家平均。

### 9.2 动作头

| 头 | 使用场景 | 核心标签 | 输出 |
|---|---|---|---|
| Entry | 未持仓 | 建仓相对等待的净R | `Q(BUY)-Q(WAIT)` |
| Add | 已持仓 | 加仓相对持有的增量净R | `Q(ADD)-Q(HOLD)` |
| Hold | 已持仓 | 继续持有的净R分布 | 均值、Q10、MFE/MAE |
| Reduce | 已持仓可卖 | 多种减仓比例相对持有的增量 | 25/50/100% 动作价值 |
| Exit | 已持仓可卖 | 立即退出相对持有的增量 | 退出价值、反弹机会成本 |
| Review | 已有决策 | 原决策失效/改变的概率 | 稳定性、重算价值 |

### 9.3 止损与止盈

- `hardStop`：确定性规则，不训练模型。
- 普通止损：进入 Reduce/Exit 头。
- 止盈：进入退出时机头，比较立即兑现、分批兑现、继续持有。
- 移动止损：由风险模型提供尾部概率，规则层决定是否更新，不允许下移既有保护。

## 10. 统一动作价值合同

所有任务头输出 `action-value-vector.v1`：

```json
{
  "schemaVersion": "action-value-vector.v1",
  "asOf": 0,
  "code": "000001",
  "stateFingerprint": "state.xxx",
  "encoderVersion": "state-encoder.xxx",
  "actions": [
    {
      "action": "ADD",
      "route": "PULLBACK",
      "feasible": true,
      "pFill": 0.0,
      "pSuccessGivenFill": 0.0,
      "gainR": 0.0,
      "lossR": 0.0,
      "expectedNetR": 0.0,
      "q10R": 0.0,
      "cvarR": 0.0,
      "uncertainty": 0.0,
      "horizonDays": 0,
      "headVersion": "add-head.xxx"
    }
  ],
  "evidenceCoverage": {},
  "ood": {},
  "trace": {}
}
```

统一仲裁器只比较 `feasible=true` 的动作：

```text
actionUtility =
  expectedNetR
  + avoidedTailLossR
  - executionCostR
  - uncertaintyPenaltyR
  - opportunityCostR
```

最终动作仍由服务端生成 `decision-plan.v2` 或其后继版本，模型不输出手数。

## 11. 数据与标签体系

### 11.1 权威对象

```text
DecisionStateSnapshot
ActionAlternative
ExecutionOutcome
PositionOutcome
ReviewOutcome
ModelDecisionTrace
```

`DecisionStateSnapshot` 必须保存决策时可见的全部市场、个股、账户和证据状态。
后续数据只能进入标签，不得回写输入。

### 11.2 反事实动作标签

每个持仓快照同时回放：

- 不操作；
- 加仓一个风险单位；
- 减仓 25%；
- 减仓 50%；
- 全部退出。

每条路径使用相同后续行情、费用、滑点、T+1 和止损规则。标签为相对 HOLD 的
账户价值变化，而不是只记录用户实际选择的动作。

### 11.3 各任务标签

| 任务 | 标签 |
|---|---|
| 选股 | 各路径最大合法费后净R、TopK relevance |
| 买入 | 成交、1/3/5 日净R、Q10、MFE/MAE |
| 加仓 | `wealth(ADD)-wealth(HOLD)` |
| 减仓 | `wealth(REDUCE_x)-wealth(HOLD)` |
| 退出 | `wealth(EXIT)-wealth(HOLD)` |
| 执行 | 成交时间、成交比例、滑点、逆向选择 |
| 风险 | 失效价先达概率、Q05/Q10、CVaR、最大回撤 |
| 复核 | 原动作是否改变、重算避免损失、等待价值 |

### 11.4 行为策略与因果字段

为未来离线 RL/OPE 新增：

```text
candidateActions
chosenAction
behaviorProbability
actionEligibility
policyVersion
decisionReasonCodes
```

缺少 `behaviorProbability` 和动作覆盖时，禁止使用 SCOPE-RL 的 OPE 数值作为
生产晋级依据。CausalML 只能在处理组/对照组具有可接受 overlap 后用于研究。

## 12. 训练架构

### 12.1 训练阶段

1. 校验不可变市场分片和成熟结果。
2. 构建 point-in-time 状态快照。
3. 生成合法动作和反事实执行路径。
4. 按标签结束时间执行 purged walk-forward。
5. 训练共享编码器和任务头。
6. 使用 OOF 预测训练 router/stacker。
7. 在独立校准区校准每个头。
8. 在独立盲测区进行单头和组合评估。
9. 执行账户级顺序回放。
10. 通过后写不可变模型包，最后原子更新 manifest。

### 12.2 损失函数

```text
L =
  w_selection * LambdaRank
  + w_fill * BinaryLogLoss
  + w_success * BinaryLogLoss
  + w_value * Huber
  + w_tail * PinballLoss
  + w_hazard * SurvivalNLL
  + w_review * BinaryLogLoss
```

第一版固定权重并记录每个任务梯度；出现负迁移后再 POC GradNorm、PCGrad 或
LibMTL，不在没有证据时引入复杂动态权重。

### 12.3 样本准入

- 任何动作头至少覆盖 120 个独立交易日；
- 二分类头正负类各至少 500 条成熟样本；
- 回归头至少 5,000 条完整费后结果；
- 深度共享编码器至少需要 100,000 个成熟状态和 250 个交易日；
- 不满足时使用共享树模型或规则，不用过采样伪造独立信息量。

## 13. 运行时架构

### 13.1 组件

```text
api/
  _decision_orchestrator.js
  _decision_state.js
  _action_value_client.js

shared/
  decisionStateContract.js
  actionValueContract.js
  actionEligibility.js
  actionValueArbiter.js
  accountRiskGateway.js
  reviewPolicy.js

qlib-service/decision_engine/
  contracts.py
  state_encoder.py
  router.py
  registry.py
  inference.py
  heads/
    selection.py
    entry.py
    position.py
    execution.py
    risk.py
    review.py
  training/
    datasets.py
    counterfactuals.py
    splits.py
    trainer.py
    calibration.py
    evaluation.py
    release.py
```

初期所有 Python 任务仍运行在一个量化服务中，保持一次请求、一次快照和一个模型
清单；只有 GPU 编码器的资源需求被证明后，才把共享编码器迁到 EAS。逻辑拆分
不等于立即拆微服务。

### 13.2 请求时序

1. Node 从行情、板块、资金和账本构建 `decision-state.v1`。
2. 确定性路由计算合法动作集合。
3. 量化服务一次返回所有合法动作的价值向量。
4. 风控网关删除非法动作并调整风险预算。
5. 仲裁器选择唯一动作。
6. 计划编译器生成价格、手数和人工核对条件。
7. LLM 对只读决策包生成解释。
8. 触价后复核头判断是否需要立即重算；最终动作仍由步骤 3-5 产生。

### 13.3 失败策略

| 失败 | 行为 |
|---|---|
| 选股模型不可用 | 不产生新增候选 |
| 组合模型不可用 | 禁止买入/加仓；不伪造持仓动作 |
| 执行模型不可用 | 禁止新增风险；硬退出使用确定性价格路径 |
| 风险模型不可用 | 禁止新增风险；账户硬规则继续工作 |
| 复核模型不可用 | 按现有确定性触发器重跑完整决策 |
| 部分头版本不兼容 | 整包拒绝加载 |
| 新模型不通过门禁 | 保持当前生产 manifest |

## 14. 模型包与版本

`decision-model-manifest.v1`：

```json
{
  "schemaVersion": "decision-model-manifest.v1",
  "version": "decision-engine.YYYYMMDDTHHMMSSZ",
  "stateSchemaVersion": "decision-state.v1",
  "encoder": {
    "version": "state-encoder.xxx",
    "runtime": "onnx"
  },
  "router": {
    "version": "action-router.xxx"
  },
  "heads": {
    "selection": {},
    "entry": {},
    "position": {},
    "execution": {},
    "risk": {},
    "review": {}
  },
  "calibration": {},
  "compatibility": {},
  "releaseManagement": {}
}
```

规则：

- 编码器变化必须重训并验证全部头；
- 编码器不变时允许任务头选择性晋级；
- 任一头输出缺字段、NaN 或版本不兼容时整包失败关闭；
- 模型文件不可变，manifest 最后原子切换；
- 每次决策记录编码器、router、所有参与头和仲裁器版本。

## 15. 验收与发布门禁

### 15.1 单任务指标

| 任务 | 核心指标 |
|---|---|
| 选股 | Precision@5、NDCG@5、Top5 净R下界、召回覆盖 |
| 买入/加仓 | Brier、LogLoss、AUC、增量净R MAE、校准曲线 |
| 持有/减仓/退出 | policy regret、避免损失、放弃上涨、动作混淆矩阵 |
| 执行 | pFill Brier、滑点 MAE/Q90、成交时间 C-index |
| 风险 | Q10/Q05 覆盖、CVaR误差、尾部事件召回率 |
| 复核 | 决策改变召回率、无价值复核率、避免损失 |

### 15.2 整体指标

- 费后净R和 95% 下界；
- 最大回撤和最差单日R；
- 正净R命中率；
- 正期望覆盖率；
- 换手和总费用；
- 单股、行业和账户暴露；
- 动作冲突数必须为 0；
- T+1、现金、仓位和硬止损违规数必须为 0；
- 推理 P95 和模型包大小。

### 15.3 发布规则

- 单头改善不代表整包晋级；
- 新编码器必须通过所有任务和账户回放；
- 允许编码器不变时选择性替换单头；
- 不允许用总体均值覆盖最近窗口负下界；
- 持仓新内核不做生产影子双轨；
- 离线回放、测试账号全链路、完整门禁通过后一次切换；
- 生产清单保留上一版本快速回滚。

## 16. 优先级与里程碑

### M0：冻结合同与基线

目标状态：

- 固定 `decision-state.v1`、`action-value-vector.v1` 和标签定义；
- 保存当前 V3 的完整离线基线；
- 统计各动作成熟样本和覆盖日期。

退出条件：

- Schema 双端测试通过；
- 所有当前生产输入可无损转换；
- 账户和交易数据不需要迁移。

### M1：四任务域解耦，行为不变

目标状态：

- 新 orchestrator 调用 Selection、Portfolio、Execution、Risk 接口；
- 内部仍由当前 V3 和现有规则提供结果；
- 新旧输出逐字段一致。

风险控制：

- 只做适配层；
- 不改变生产动作；
- 不删除旧实现。

### M2：执行与风险头

目标状态：

- `pFill`、滑点、成交时间从方向模型拆出；
- Q10/CVaR/退出 hazard 独立；
- 硬规则仍由 Node 执行。

退出条件：

- 执行和风险单头通过；
- 新增风险动作在缺失任一头时失败关闭；
- 账户 Harness 全通过。

### M3：持仓反事实数据

目标状态：

- 对每个持仓快照生成 ADD/HOLD/REDUCE/EXIT 同源反事实；
- 保存动作 eligibility、行为策略概率和费用；
- 建立账户级顺序回放。

退出条件：

- 120 个交易日；
- 每个主要动作具备足够正负样本；
- 反事实账本与真实成交核对一致。

### M4：共享编码器与多任务头

目标状态：

- 训练共享编码器、任务 gate 和动作头；
- 树模型作为冠军；
- MMoE/PLE 作为挑战者。

退出条件：

- 所有单头通过；
- 最近窗口下界为正；
- 账户级净R和回撤通过；
- 推理容量和故障降级通过。

### M5：复核头与完整闭环

目标状态：

- 复核头只判断决策稳定性和重算价值；
- 触价、60秒观察、重新决策和通知同源；
- 不新增第二套动作政策。

退出条件：

- 关键动作改变召回率达标；
- 无价值复核显著下降；
- 超时仍产生明确终态。

### M6：一次性切换与删除

进入条件：

- 离线全量回放通过；
- 测试账号持仓、自选、复核、成交归因全链路通过；
- 新架构所有模型包已回读验证；
- 回滚清单已演练。

切换后删除：

- `api/_v3_decision.js`，由 `_decision_orchestrator.js` 替代；
- `shared/adaptiveOpportunity.js`，由统一仲裁器替代；
- `shared/adaptiveAdvicePolicy.js` 中的决策计算，只保留展示投影后删除；
- `shared/holdingActionValue.js` 中的手工价值公式；
- `qlib-service/opportunity_model.py` 的单体加载和推理职责；
- `train_opportunity_score.py`、`train_opportunity_seed_ensemble.py` 的旧训练入口；
- 已完成回归迁移后的 `poc_v3_*` 和旧模型 Schema 适配器。

继续保留：

- `account`、`holding`、`closed`、`transactions`；
- `executionPlans`、`executionAttributions`；
- T+1 批次、费用和真实成交关联；
- `decisionPlan.js` 的确定性执行计划能力；
- `accountCircuitBreaker.js`；
- 市场数据归档、成熟结果和 Harness；
- 价格路径生成器，但移除其旧决策权。

## 17. 目标文件边界

| 当前模块 | 目标 |
|---|---|
| `api/_v3_decision.js` | 重写为只负责编排的 `_decision_orchestrator.js` |
| `shared/adaptiveOpportunity.js` | 替换为 `actionValueArbiter.js` |
| `shared/adaptiveAdvicePolicy.js` | 拆为动作合同与展示投影 |
| `shared/holdingActionValue.js` | 删除手工公式，改读 Portfolio Heads |
| `shared/decisionPlan.js` | 保留并升级为最终确定性执行编译器 |
| `shared/accountCircuitBreaker.js` | 保留为账户风险网关 |
| `shared/adaptivePricePlans.js` | 保留为候选路径生成器 |
| `shared/opportunityPlaybooks.js` | 保留为专家特征，不再直接决定动作 |
| `qlib-service/opportunity_model.py` | 拆为 registry、encoder、router、heads、inference |
| `qlib-service/train_opportunity_score.py` | 由统一 trainer 和任务数据集替代 |

## 18. 风险与控制

| 风险 | 预防 | 检测 | 响应 |
|---|---|---|---|
| 任务负迁移 | 任务专用 experts、梯度监控 | 单头相对冠军指标 | 降级为树模型或独立头 |
| 专家塌缩 | gate 熵、专家使用率下限 | 每日专家占比 | 冻结 router 或均匀路由 |
| 动作冲突 | 统一价值合同和合法动作掩码 | 冲突计数 | 整包拒绝 |
| 选择偏差 | 全动作反事实、propensity 记录 | overlap/ESS | 禁止因果或 OPE 结论 |
| 市场漂移 | 近期权重、TRA 风格路由 | 分阶段校准和 PSI | 缩小风险或回滚 |
| 尾部低估 | Q05/Q10/CVaR 和压力情景 | 覆盖率、最差日 | 阻断新增风险 |
| 推理超时 | 一次共享编码、多头并行 | P95/P99 | 回退当前生产包 |
| 模型部分缺失 | Manifest 完整性校验 | 加载错误计数 | 整包失败关闭 |
| 迁移资损 | 测试账号和账户级回放 | 账本守恒 | 回滚 manifest |
| 开源供应链 | 固定 SHA、许可证审查、最小依赖 | SBOM/漏洞扫描 | 替换或隔离组件 |

## 19. 验收与指标

| ID | 场景 | 预期 |
|---|---|---|
| AC-01 | 未持仓、三路径均合法 | 只从 BUY/WAIT 中输出一个动作 |
| AC-02 | 已持仓且盈利强化 | ADD 仅在相对 HOLD 增量为正时胜出 |
| AC-03 | 已持仓且普通转弱 | REDUCE/EXIT 与 HOLD 同尺度比较并先复核 |
| AC-04 | 触及账本硬止损 | 不调用模型即可退出或标记 T+1 锁定 |
| AC-05 | 目标价达到但趋势仍强 | 止盈头比较兑现与继续持有，不机械清仓 |
| AC-06 | 加仓后现金或风险不足 | 风控层将 ADD 标记为不可执行 |
| AC-07 | 触价后路径恢复 | 复核头触发重算，统一动作头可撤销原动作 |
| AC-08 | 任一模型头缺失 | 禁止新增风险，硬退出仍可执行 |
| AC-09 | 编码器版本不匹配 | 整包拒绝加载 |
| AC-10 | 新模型总体均值高但最近窗口下界负 | 不晋级 |
| AC-11 | 多设备执行计划合并 | 完成状态不得被旧版本回滚 |
| AC-12 | 生产回滚 | 原子恢复上一模型包且账本不变 |

## 20. 需求追溯

| 目标 | 架构机制 | 验收 |
|---|---|---|
| 不同任务使用不同模型 | 四任务域、多头 | AC-01 至 AC-07 |
| 动作仍可统一比较 | Action Value Normalizer | AC-01、AC-03 |
| 不破坏账户纪律 | Deterministic Router + Risk Gateway | AC-04、AC-06 |
| 降低负迁移 | 共享/专用专家和单头晋级 | AC-09、AC-10 |
| 可安全替换 V3 | 适配层、一次切换、原子回滚 | AC-12 |
| 可追溯 | 版本化状态、头、router、仲裁记录 | 全部 |

## 21. 开放问题

| 问题 | 需要的证据 | 未解决时默认 |
|---|---|---|
| ADD/REDUCE/EXIT 各有多少成熟样本 | 全量数据盘点 | 不训练专用头 |
| 持仓反事实模拟误差多大 | 与真实成交和后续行情核验 | 不用于晋级 |
| 深度编码器是否优于树模型 | 同切分消融实验 | 树模型继续生产 |
| 行为策略概率是否可靠 | 日志完整率、ESS、overlap | 不使用离线 RL |
| 生存模型许可证和运行时 | 法务与部署 POC | 自研离散 hazard |
| EAS 延迟和成本 | 80 路径批量压测 | 保留 FC 树模型 |

## 22. 决策记录

| 日期 | 决策 | 状态 | 后果 | 重新评估条件 |
|---|---|---|---|---|
| 2026-09-11 | 采用四任务域和统一动作价值 | Proposed | V3 作为迁移基线，不再作为长期结构 | 评审否决或数据证明统一模型更优 |
| 2026-09-11 | 使用共享编码器和任务专用头 | Proposed | 编码器变化要求整包重训 | 深度模型无稳定增益 |
| 2026-09-11 | 硬止损保持规则化 | Proposed | 风控不受模型漂移影响 | 不允许翻转 |
| 2026-09-11 | 暂不采用端到端 RL | Proposed | 先建设反事实和行为策略数据 | OPE 和账户回放均通过 |
| 2026-09-11 | 不整套引入开源交易框架 | Proposed | 只复用经过验证的算法和接口思想 | 某框架完成 A 股合同 POC |

## 23. 实施交接

Design document and immutable revision:

- `docs/multi-task-trading-engine-redesign.md`
- 设计版本 `multi-task-trading-engine.v1`

Acceptance status:

- 方案已形成，尚待评审；
- 未实施、未训练新生产模型、未部署。

Normative claims:

- 四任务域；
- 共享状态编码器；
- 确定性合法动作路由；
- 任务专用多头；
- 统一费后动作价值；
- 硬止损和账户约束不学习化；
- 持仓内核通过离线和测试账号后一次切换。

Open blockers:

- 持仓动作样本盘点；
- 反事实标签生成器；
- 状态 Schema 评审；
- 树模型基线与 MMoE POC；
- 账户级顺序回放门禁。

## 24. 参考资料

- [Qlib](https://github.com/microsoft/qlib/tree/79633dd9506ea689e5400dea0197717b5b3d74b7)
- [LibMTL](https://github.com/median-research-group/LibMTL/tree/4336804847eaa5e0b924b743d76beec7ac3fdc97)
- [d3rlpy](https://github.com/takuseno/d3rlpy/tree/38c34b6f99fde82875e2ad81d1ba1f7a7da34137)
- [SCOPE-RL](https://github.com/hakuhodo-technologies/scope-rl/tree/b1c9e9fbfddd924362160ec5e9f9f071abc7b7ea)
- [CausalML](https://github.com/uber/causalml/tree/9a2327811406240925e9b8c0ce16734a04da52d7)
- [scikit-survival](https://github.com/sebp/scikit-survival/tree/7c56aba0a8b55f82dd92cac4df040e27f68d9e79)
- [TensorTrade](https://github.com/tensortrade-org/tensortrade/tree/d58afba23deb1fded39793203b7997c3990bb032)
- [NautilusTrader](https://github.com/nautechsystems/nautilus_trader/tree/30d88481852a914d07f91104945e8e7e95234e2d)
- [FinRL](https://github.com/AI4Finance-Foundation/FinRL/tree/2334a5fe6d30629157f13c3b0319e1637e15e123)
- [FinRL-X](https://github.com/AI4Finance-Foundation/FinRL-Trading/tree/e65d6f0483ead7d2ef4a5fc940cdf960392a25c1)
- [TradeMaster](https://github.com/TradeMaster-NTU/TradeMaster/tree/1747cc18db3fe2639af12defc80e138c51a625c0)
- [现有自适应交易引擎](../adaptive-trading-engine.md)
- [V3 选择性发布 ADR](../decisions/ADR-004-v3-selective-model-release.md)
- [Harness Engineering](../harness-engineering.md)
- [V3 市场数据归档](../v3-market-data-archive.md)
