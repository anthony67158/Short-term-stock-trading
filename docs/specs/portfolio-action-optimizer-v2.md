# Spec: Portfolio Action Optimizer V2

## Objective

将现有持仓动作适配器从线性镜像公式升级为离散仓位优化器，使 `HOLD`、`REDUCE`
和 `EXIT` 都能在经济上独立胜出。

当前公式满足：

```text
exitRelativeToHoldR = 2 * reduceRelativeToHoldR
```

因此当持有价值转负时，只要全部卖出合法，`EXIT` 几乎必然压过 `REDUCE`。V2 不以
“让当前两只股票变成持有”为目标，而以消除该结构偏置、输出可审计的费后绝对动作
价值为目标。

目标用户是需要明确知道“继续持有、卖一部分还是全部退出”的 A 股散户。成功结果
必须同时说明保留仓位、卖出手数、剩余上涨价值、释放的尾部风险、交易成本和最终
净动作价值。

## Scope

### In Scope

- 枚举卖出比例 `0% / 25% / 50% / 75% / 100%`，并按整手与 T+1 可卖数量修正。
- 使用现役模型的持有期望 `E` 和下界 `L`，计算尾部损失 `D=max(0,-L)`。
- 使用真实 A 股卖出费用、5 bps 滑点、持仓价格和止损距离换算费后 `R`。
- 用非线性剩余风险使部分减仓可能优于持有和清仓。
- 非持有动作必须显著优于持有至少 `0.05R`，否则保持 `HOLD`，降低频繁反复交易。
- 将选择比例、卖出手数和价值分解写入可选的
  `positionOptimization` 合同；旧字段继续只读兼容。
- 收盘次日预案和决策依据展示优化后的精确减仓手数及价值分解。

### Out of Scope

- 不改变 36 维 OHLCV 模型输入。
- 不声称 V2 是独立训练的卖出模型。
- 不修改买入、加仓、价格路径或硬止损规则。
- 不为使生产持仓保留而人工降低退出分数。
- 本次不新增模型训练标签；未来训练头通过同一合同接入。

## Optimization Contract

### Inputs

```js
{
  expectedHoldR,       // E，现役模型持有期费后期望
  lowerBoundR,         // L，模型净R下界
  price,
  hardStopPrice,
  totalLots,
  sellableLots,
  stockWeightPct,
  maxStockWeightPct,
  slippageBps: 5,
  feePolicy: A_SHARE_STANDARD_V1
}
```

### Candidate Utility

对每个合法卖出比例 `s`，剩余比例 `h=1-s`：

```text
D = max(0, -L)
concentration = clamp(stockWeightPct / maxStockWeightPct, 0, 1)
lambda = 0.35 + 0.40 * concentration

remainingExpectedR = h * E
remainingTailPenaltyR = lambda * h² * D
sellCostR = (真实卖出费用 + 5bps滑点) / 全仓计划风险金额
switchPenaltyR = s * clamp(0.05 * max(0, E-L), 0.02, 0.10)

actionUtilityR =
  remainingExpectedR
  - remainingTailPenaltyR
  - sellCostR
  - switchPenaltyR
```

非线性的 `h²` 使减仓能够在“仍有上涨价值但尾部风险偏大”时独立胜出。全部退出不再
获得旧公式中的机械正奖励，只保留 `0` 未来敞口并扣除费用与切换惩罚。

### Output

```js
{
  schemaVersion: 'position-optimization.v2',
  source: 'DISCRETE_POSITION_OPTIMIZER',
  selectedAction: 'HOLD' | 'REDUCE' | 'EXIT',
  selectedSellLots,
  selectedRetainedLots,
  selectedUtilityR,
  holdUtilityR,
  improvementOverHoldR,
  candidates: [{
    action,
    sellLots,
    retainedLots,
    soldFraction,
    remainingExpectedR,
    remainingTailPenaltyR,
    sellCostR,
    switchPenaltyR,
    actionUtilityR,
    feasible
  }]
}
```

该对象作为 `action-value-vector.v1` 的可选新增字段，不删除或改变现有字段类型。

## Selection Rules

1. 账本硬止损继续直接选择合法的 `EXIT/REDUCE`，不经过 V2。
2. 证据、模型或账户不完整时不运行 V2，保持现有失败关闭逻辑。
3. 只枚举不超过 `sellableLots` 的整手候选。
4. 一手持仓无法产生部分减仓候选，只比较持有和退出。
5. 非持有候选只有比持有改善至少 `0.05R` 才能胜出。
6. 同分时优先 `HOLD`，其次较少卖出手数，避免无意义换手。
7. 普通 `REDUCE/EXIT` 仍先进入约 60 秒退出复核；复核可改回 `HOLD`。

## Tech Stack And Structure

```text
shared/positionActionOptimizer.js       V2 优化与合同
shared/actionValueArbiter.js            接入候选与选择结果
shared/actionValueContract.js           添加可选分解字段
shared/decisionEnginePolicy.js          使用精确卖出手数
shared/decisionPlan.js                  持久化精确数量
shared/decisionRationale.js             输出动作价值分解
shared/nextSessionPlan.js               收盘预案复用精确数量
test/                                   Node 合同与回归测试
harness/                                执行及生命周期回放
docs/adaptive-trading-engine.md         架构说明
```

## Code Style

```js
const candidates = sellLots.map((lots) => (
  evaluatePositionCandidate({
    expectedHoldR,
    lowerBoundR,
    totalLots,
    sellLots: lots,
    execution,
  })
))
```

- 纯函数优先；相同输入必须得到相同结果。
- 所有金额、比例和 `R` 在边界校验后进入计算。
- 用户可见说明使用普通中文，不暴露内部枚举。
- 新合同只做可选字段扩展，不破坏旧建议读取。

## Commands

```bash
node --test test/position-action-optimizer.test.js
node --test test/action-value-arbiter.test.js test/decision-engine.test.js
npm test
npm run harness
set -a; . ./.env; set +a; npm run harness:continuous
npm run build
```

## Testing Strategy

- 单元测试覆盖 `HOLD`、`REDUCE`、`EXIT` 各自胜出。
- 属性测试覆盖 `0 <= sellLots <= sellableLots <= totalLots`。
- 回归测试证明 `EXIT != 2 * REDUCE`，且一手持仓不会生成非法部分减仓。
- 费用测试覆盖最低 5 元佣金、印花税、过户费和滑点。
- 决策测试覆盖 T+1、硬止损、退出复核和精确减仓手数。
- 连续市场对比旧版与 V2 的动作分布、换手、费用、净R和最大回撤；不得只比较命中率。

## Boundaries

### Always

- 使用真实 A 股费用和整手约束。
- 保留硬止损与 T+1。
- 非持有动作必须经过最小改善门槛。
- 公开每个候选的价值分解。
- 保持旧合同可读。

### Ask First

- 修改 36 维模型口径。
- 新增训练标签或替换生产模型。
- 降低硬止损、数据完整性或费后门槛。

### Never

- 为了减少清仓次数而强制持有。
- 用 LLM 选择动作或卖出手数。
- 把研究分、影子分或不完整模型结果用于生产动作。
- 将未复核的普通退出直接标记为已授权成交。

## Success Criteria

- `HOLD`、`REDUCE`、`EXIT` 在固定测试场景中均可成为最优动作。
- 不再存在 `exitUtilityR === 2 * reduceUtilityR` 的结构恒等式。
- 减仓计划的手数来自获胜候选，不再默认卖出全部可卖手数。
- 当前生产两只持仓用 V2 重算时有完整分解；即使仍选择退出，也能证明不是公式镜像导致。
- 全量 Node、Harness、连续市场和生产构建通过。
- Vercel 与 FC 双部署后，仅使用测试账号执行副作用验收；个人生产账号只读。

## Implementation Tasks

- [x] 实现 `position-optimization.v2` 纯函数和三类动作测试。
- [x] 在动作仲裁器中优先使用 V2，保留 V1 兼容回退。
- [x] 将精确卖出手数贯穿决策计划、退出复核和收盘预案。
- [x] 更新决策依据，展示上涨保留、风险释放、费用和净改善。
- [ ] 完成全量测试、连续回放、双部署和线上只读验收。

## Open Questions

无阻塞问题。参数均作为版本化常量写入合同；若离线回放显示换手或回撤恶化，V2
不得上线，需先更新本规格和参数依据。
