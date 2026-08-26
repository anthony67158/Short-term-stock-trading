# Implementation Plan: 极致短线游击作战闭环

## Phase 1：单股主链替换

### Task 1：唯一作战快照

**Acceptance**

- [x] 快速与深度军师只读取 `short-horizon-tactical.v1`。
- [x] 量化和新闻保留为战术参考，不直接决定动作。
- [x] 旧零散市场、共振和资金对象不再直接进入军师 Prompt。
- [x] `short-horizon-action-policy.v1` 在生成前限定允许动作，
  Decision Compiler 对集合外动作进行确定性改写。
- [x] 建仓/加仓同时服从时机、量化、主力资金、流动性、拥挤度和事件风险。
- [x] 减仓/退出不被新增风险规则阻断，做 T 未完成腿不得反向。

**Verify**

```bash
node --test test/short-horizon-tactical.test.js \
  test/advisor-calibration-prompt.test.js
```

### Task 2：单股作战生命周期

**Acceptance**

- [x] 同一股票只处于一个作战阶段。
- [x] 阶段由建议、价格、执行计划和真实成交确定。
- [x] 终态不能被旧建议或旧设备回滚。

**Files**

- `shared/opportunityLifecycle.js`
- `shared/decisionPlan.js`
- `shared/executionPlan.js`
- 对应测试

### Checkpoint A

- [x] 单股建议从事实到人工执行形成完整链路。
- [x] 全量单元测试通过。

## Phase 2：资金轮动

### Task 3：仓位诊断输出首要轮动动作

**Acceptance**

- [x] 同时比较最弱持仓与最强候选。
- [x] 计入费用、滑点、现金和 T+1 隔夜风险。
- [x] 每次最多一个首要换仓动作，代码与股票必须来自真实输入。

**Files**

- `api/portfolio_analysis.js`
- `shared/portfolioAnalysis.js`
- `shared/portfolioAdviceBrief.js`
- 对应测试

### Task 4：候选机会队列

**Acceptance**

- [x] 候选明确分为立即关注、回踩候选和淘汰。
- [x] 排序包含板块角色、相对强弱、资金、量化、流动性和拥挤风险。
- [x] 没有立即买点时仍返回条件候选。

**Files**

- `shared/stockRanking.js`
- `api/screen.js`
- 对应测试与 Harness

### Checkpoint B

- [x] 仓位与候选能够形成一条资金轮动建议。
- [x] 不产生多个互相冲突的首要动作。

## Phase 3：退出、复核与学习

### Task 5：退出与机会成本

**Acceptance**

- [x] 止损、派发、板块退潮、分批止盈和到期重评有明确优先级。
- [x] 新仓 T+1 无法退出时给出下一交易日优先动作。
- [x] 盈利保护不依赖模型重复生成。

### Task 6：事件驱动复核

**Acceptance**

- [x] 战术状态实质变化进入复核。
- [x] 无实质变化继续复用原建议。
- [x] 五分钟结构、板块角色和资金关系事件统一进入事件队列。

### Task 7：真实成交学习

**Acceptance**

- [x] 学习记录包含战术状态、窗口和触发路径。
- [x] 增加持有时长、最大有利/不利波动和盈利捕获率。
- [x] 样本不足时不调整风险倍率。

### Checkpoint C

- [x] 执行、退出、复核和学习闭环通过 Harness。

## Phase 4：用户体验与发布

### Task 8：极简作战摘要

**Acceptance**

- [x] 第一屏只显示唯一动作、作战阶段、短线窗口、优势、风险和重评条件。
- [x] 不出现内部枚举、策略卡或影子建议。
- [x] 桌面和移动端无重叠、跳动和文本溢出。

### Task 9：系统验证与替换上线

**Acceptance**

- [x] `npm test`、`npm run harness:ci`、`npm run build` 全部通过。
- [x] 快速生成不超过 75 秒，深度生成不超过 150 秒。
- [x] Vercel 与 FC 使用同一提交。
- [x] 只用测试账号执行生产生成验收。
- [x] 删除旧 Prompt、旧双轨入口和调试内容。
