# V3 后置解释与 LLM 角色收敛

## Objective

V3 和确定性风控继续拥有动作、路径、价格、手数、费用、T+1 与账户风险的
唯一决策权。LLM 只承担不改变决策的解释、研究、问答和复盘表达。

物理 LLM 角色由七个收敛为四个：

| 角色 | 用途 | 槽位 |
|---|---|---:|
| `explain` | V3 白话解释、组合诊断解释、做T数据解释 | 2 |
| `assistant` | 带工具的用户问答 | 1 |
| `daily` | 盘前、午间、盘后策略日报 | 1 |
| `sector` | 板块前瞻与题材解释 | 1 |

旧 `advisor`、`review`、`portfolio`、`agent`、`judge` 只用于一次性配置迁移或
历史数据兼容，不再作为新配置入口。任务表中的 `advisor` / `review` 是队列
lane，不代表 LLM 角色，暂不改名以保护运行态兼容。

## Explanation Contract

`POST /api/v3_explain`

输入只接受：

```json
{ "code": "600001", "decisionId": "decision.xxx" }
```

服务端从鉴权账号的当前建议读取权威 V3 决策，不接受客户端上传动作、价格、
手数或账户数据。输出固定为：

```json
{
  "summary": "当前为什么这样操作",
  "counterCase": "最强反方",
  "invalidation": "何时失效或重评",
  "evidenceGap": "仍缺少什么"
}
```

解释按 `decisionId` 缓存进当前建议；相同决策只调用一次。V3 结果先展示，
解释请求失败、超时或保存冲突都不得改变或撤回原决策。

## Migration

- `advisor` → `explain`，优先迁移原第一个、第二个端点。
- `portfolio` → `explain`，仅在 `explain` 对应槽位为空时补位。
- `agent` → `assistant`。
- `daily`、`sector` 原样保留。
- `review`、`judge` 不再保留物理角色；仅在前述端点仍有空槽时迁移到
  `explain`，到价复核继续调用 V3。
- `judge` 停止参与交易确认；确定性信号与 V3 复核形成终态。
- 新配置保存后只写四角色；旧字段只读，不回写。

## Boundaries

- Always：服务端读取权威建议；校验 `decisionId`；LLM 输出做结构和长度校验；
  解释缓存前再次校验当前决策；调用与保存均有超时。
- Never：LLM 修改动作、价格、手数、路径、止损、目标、账户预算或费后期望；
  解释失败阻断 V3；旧角色跨池回退；打印或提交 Key。
- Compatibility：账户、成交、执行计划、任务 lane 和旧建议继续读取；旧 LLM
  配置自动迁移为四角色视图。

## Commands

```bash
npm run test:ci
npm run harness
npm run build
npm run package:fc
```

## Testing

- 配置迁移：旧七角色配置解析为四角色，保存结果不含旧角色。
- 路由隔离：四角色只使用自身槽位；解释与助手互不借用。
- 解释接口：未登录、错版、缓存命中、模型失败、输出越权、保存冲突。
- 决策不变：解释前后 `decisionPlan`、价格、手数和 `decisionId` 深度相等。
- 浏览器：详情页按需生成、加载、缓存、错误、刷新恢复和移动端无溢出。

## Success Criteria

- 配置页只显示四个角色。
- 单股 V3 决策与到价复核保持零 LLM 决策调用。
- “白话解读”最多每个 `decisionId` 调用一次，并且无法改写决策。
- 旧配置无人工处理即可迁移。
- 全量测试、Harness、四断点浏览器验收和双部署通过。
