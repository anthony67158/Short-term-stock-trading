# Harness Engineering 规格

## 目标

把现有 AI 交易系统中分散的工具、证据、回放、风控和测试统一成可扩展的
Harness。每次评估都产出一个可审计 episode，回答：

1. 输入与版本是什么。
2. 实际经过哪些阶段。
3. 输出是否正确、可执行、可追溯且满足风险约束。
4. 失败属于数据、模型、工具、契约、风控还是性能。
5. 本次变更相对基线是提升还是退化。

Harness 是模型之外的可靠性运行层，而不是新的模型或 Prompt 集合。参考：

- https://www.deepset.ai/blog/harness-engineering
- https://arxiv.org/html/2605.13357
- https://nodejs.org/api/test.html
- https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs

## 技术栈

- Node.js 20+，ES modules。
- Node 内置 `node:test`，不新增测试依赖。
- JSON 场景、JSON episode、Markdown 摘要。
- GitHub Actions 使用 `npm ci` 和固定 Node 20。

## 命令

```bash
# 默认运行全部离线套件并写报告
npm run harness

# CI 门禁，不依赖外网或密钥
npm run harness:ci

# 只运行持仓再平衡套件
node harness/run.mjs --suite portfolio

# 显式运行线上端点矩阵/影子对拍（付费，不进入默认CI）
npm run harness:online
npm run harness:shadow

# 输出 JSON 到 stdout，不写 artifacts
node harness/run.mjs --suite portfolio --format json --no-write

# 把生产失败脱敏导出为回归case，再立即重放
npm run harness:export -- --input failure.json
node harness/run.mjs --suite judge \
  --case-file cases/regressions/<case-id>.json --no-baseline

# 仅允许全部离线suite通过后，人工确认并更新提交基线
node harness/run.mjs --update-baseline

# 现有真实军师在线抽样，保持兼容；凭证仅存在当前进程
HARNESS_NICK=... HARNESS_PASSWORD=... npm run harness:advice
```

## 目录

```text
harness/
  manifest.json                  套件、评分权重、门槛和适配器注册
  run.mjs                        单一 CLI 入口
  export.mjs                     生产失败脱敏导出入口
  baselines/current.json         已提交的维度基线
  cases/
    portfolio.json               持仓再平衡离线场景
    evidence.json                证据回放场景
    advice.json                  军师数值校验场景
    judge.json                   确认闸门场景
    screen.json                  AI选股评分与入场确认场景
    daily.json                   日报事实场景
    endpoint.json                显式在线端点矩阵
    shadow.json                  显式在线影子对拍
    regressions/                 生产失败导出的临时回归场景
  adapters/
    portfolio.mjs                调生产标准化与风控模块
    evidence.mjs                 调证据快照回放
    advice.mjs                   调军师数值校正
    judge.mjs                    调确认融合策略
    screen.mjs                   调选股排序和决策归一化
    daily.mjs                    调日报摘要构建
    endpoint.mjs                 运行时端点能力矩阵
    shadow.mjs                   多端点影子对拍
  lib/
    loader.mjs                   Manifest/场景边界校验
    runner.mjs                   阶段编排、episode 和退出结论
    scorers.mjs                  可组合多维评分
    reporter.mjs                 JSON/Markdown 报告
    baseline.mjs                 基线趋势与回撤比较
    exporter.mjs                 生产失败脱敏回流
harness-artifacts/               运行产物，不入库
```

## Episode 契约

```js
{
  schemaVersion: 'harness-episode.v1',
  runId: 'run.<fingerprint>',
  suiteId: 'portfolio',
  caseId: 'concentration-rotation',
  adapter: 'portfolio',
  inputFingerprint: 'input.<fingerprint>',
  status: 'PASS', // PASS | FAIL | ERROR
  stages: [
    { name: 'load', status: 'PASS', durationMs: 0 },
    { name: 'execute', status: 'PASS', durationMs: 1 },
    { name: 'score', status: 'PASS', durationMs: 0 }
  ],
  scores: {
    contract: 1,
    groundedness: 1,
    feasibility: 1,
    actionability: 1,
    consistency: 1,
    overall: 1
  },
  failures: [],
  output: {},       // 仅白名单、安全、可回放字段
  metrics: { durationMs: 1 }
}
```

所有分数范围为 `0..1`。`overall` 使用 manifest 权重计算；任一硬门禁失败时，
即使加权总分达标，episode 仍为 `FAIL`。

## 评分模型

| 维度 | 权重 | 检查 |
|---|---:|---|
| contract | 0.20 | Schema、必填字段、枚举、有限数 |
| groundedness | 0.20 | 股票/证据白名单、无编造代码 |
| feasibility | 0.25 | 现金、整手、T+1、可执行权重 |
| actionability | 0.20 | 手数、金额、触发价、失效条件 |
| consistency | 0.15 | 股票、概念、总仓位相互守恒 |

硬门禁：

- 禁止白名单外股票进入执行单。
- 卖出手数不得超过今日可卖量。
- 买入金额不得超过服务端计算预算。
- 目标和执行后权重必须是有限数且位于 `0..100`。
- 证据编号必须来自场景证据集合。

## 场景契约

场景文件只存事实与期望，不存可执行代码：

```js
{
  id: 'concentration-rotation',
  schemaVersion: 'harness-case.v1',
  adapter: 'portfolio',
  tags: ['portfolio', 't1', 'grounding'],
  input: {
    distribution: {},
    modelOutput: {},
    allowedEvidenceIds: [],
    allowedHoldingCodes: [],
    allowedRecommendationCodes: [],
    recommendationCatalog: {}
  },
  expect: {
    minOverall: 0.9,
    requiredOrderCodes: ['300476'],
    forbiddenOrderCodes: ['000000'],
    maxT1Violations: 0
  }
}
```

## 报告

每次运行生成：

- `harness-artifacts/latest.json`：机器消费的完整 run 与 episodes。
- `harness-artifacts/latest.md`：人类可扫读的通过率、维度分和失败归因。
- `harness-artifacts/history.jsonl`：跨次运行趋势、版本和基线结果。

报告不得包含 API Key、密码、账号昵称、原始外部网页全文或隐藏推理文本。

## 边界

### Always

- 调用生产纯函数或正式 adapter，不在 harness 复制业务规则。
- 场景输入在执行前校验。
- 外部/模型输出按不可信数据处理。
- 失败返回非零退出码。
- 每个生产故障沉淀为一个最小场景。

### Ask first

- 开启真实 LLM、联网搜索、OSS 写入或生产账号抽样。
- 修改新增风险、价格、账户或证据质量阈值。
- 自动把 harness 结果用于真实交易。

### Never

- 把密钥、密码、昵称或完整账户快照写进场景/报告。
- 在 CI 默认调用付费模型或生产写接口。
- 让 LLM 自己给自己打最终分。
- 用 Prompt 规则替代可确定执行的代码门禁。

## 实施阶段

### Phase 1：Foundation + Portfolio（已完成）

- 通用 manifest、loader、runner、scorer、reporter。
- 持仓再平衡 adapter 和三类场景。
- CLI、npm 命令、CI 门禁。

### Phase 2：Decision Harness（已完成）

- 单股军师、Judge、AI 选股、策略日报 adapter。
- CanonicalEvidenceSnapshot 直接导入为场景。
- 生产失败一键脱敏导出回归 case。

### Phase 3：Online Harness（已完成）

- 真实端点能力矩阵、延迟/成本预算、空流与故障转移。
- 影子模型对拍，禁止直接影响交易。
- 基线趋势、模型/Prompt/量化版本归因。

## 验收标准

- `npm run harness:ci` 在无密钥、无网络环境可稳定运行。
- 当前 16 个离线场景覆盖持仓、证据、军师、Judge、选股和日报。
- 每个场景产出五维分数、失败归因和阶段轨迹。
- 低于 suite 门槛或硬门禁失败时进程退出码为 1。
- JSON/Markdown 报告不包含敏感字段。
- 默认运行与已提交 suite 基线对比并记录历史趋势。
- 线上端点矩阵和影子对拍必须显式 `--online`，且永不影响交易。
- 在线延迟或 Token 预算超限属于硬失败，不能被其他维度高分抵消。
- 基线更新拒绝单 suite、在线 suite 和临时 `--case-file`。
- 全量 Node 测试和生产构建保持通过。
