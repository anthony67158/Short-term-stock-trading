# 数据、API、事件与状态合同

> 隶属 `a-share-platform-rebuild.v1.0`。本册是字段语义、单位、状态和接口的唯一设计来源。  
> 下文为完整接口目录及关键合同设计；机器可执行的 OpenAPI/JSON Schema 在 T03 等任务生成并校验，当前不是已实现 API。

## 1. 基础约定

| 概念 | 合同 |
|---|---|
| ID | 不透明字符串；证券ID包含稳定市场身份，不能只用名称 |
| 股票代码 | 字符串保留前导零，另存 exchange、board、instrumentType |
| 数量 | `quantityShares` 整数股数为权威；“手”只在适用证券上做展示换算 |
| 价格 | 十进制字符串，遵循证券最小价格单位；内部 Decimal |
| 金额 | 十进制字符串，币种明确；入账精度按费用与结算政策舍入 |
| 概率 | 数值0～1；百分比仅展示层转换 |
| 收益率 | 小数，`0.03`为3%；字段名注明 gross/net |
| 时间 | UTC ISO8601，数据库 timestamptz；交易日按 Asia/Shanghai |
| 缺失 | null + missingReason；零只能代表真实零值 |
| 版本 | 整数 revision用于可变对象；不可变版本用id/hash |
| 删除 | 成交/决策不物理覆盖删除；冲正、失效、归档是明确事件 |
| 关联 | 正常化外键；JSONB只存版本化扩展和快照，不存万能账户文档 |

重要区别：成交申报单位与最终实际成交数量可能不同。导入真实成交不能机械用下单最小数量拒绝部分成交记录。

## 2. 时间合同

每条事实按需要保存：

- `occurredAt`：事件或交易发生时间；
- `publishedAt`：来源公布时间；
- `firstSeenAt`：平台首次实际获取时间；
- `availableAt`：该数据可供当前任务使用的时点；
- `recordedAt`：入库时间；
- `effectiveFrom/effectiveTo`：规则或成分关系的业务生效区间；
- `revision`：修订版本。

生产可用时间通常不早于 firstSeenAt。历史数据用可信发布档案重建时明确 `availabilityMethod`，不能把今天下载时间与当时公开时间混淆。决策按 `availableAt <= decisionAsOf` 筛选。

报价新鲜度用行情时间计算，不能以刚下载一个旧缓存的 receivedAt冒充最新行情。未收盘K线标记 `isFinal=false`，不能作为已完成收盘因子使用。

## 3. 核心实体

| 实体/表 | 关键字段 | 所有者与约束 |
|---|---|---|
| users/sessions | id、credentialsRef、expiresAt | identity；会话可撤销 |
| investment_accounts | ownerId、currency、version、riskPolicyId | portfolio；所有写入账户范围检查 |
| instruments | instrumentId、code、exchange、board、listedAt、delistedAt | market；历史状态可查询 |
| instrument_rules | instrumentScope、effectiveFrom、quantity/price/session规则 | market；生效范围不得重叠 |
| market_datasets | datasetId、range、manifestUri、hash、qualityStatus | market；发布后不可改写 |
| data_snapshots | snapshotId、asOf、datasetRefs、quality、hash | market；决策引用不可变 |
| source_documents | sourceId、url、version、原文hash、时间字段 | research；原文修订新建版本 |
| evidence_items | evidenceId、sourceId、quote、structuredFacts、validation | research；不得丢来源 |
| theses/thesis_revisions | subjectId、statement、horizon、invalidation、evidenceIds | research；历史revision不可变 |
| agent_runs/assessments | runId、protocolVersion、inputHash、产物与预算 | agents执行；research拥有业务研判 |
| strategy_versions | strategyId、version、scope、modelRefs、agentProtocolRefs | strategies；发布版本不可变 |
| scan_runs/opportunities | scanId、strategyVersion、asOf、recallSources、coverage | decisions；股票+策略+run唯一 |
| decision_contexts | accountVersion、snapshotId、assessmentIds、releaseId | decisions；整体hash |
| decisions/current_decisions | decisionId、contextId、action、status；当前指针 | decisions；账户+证券当前指针唯一 |
| execution_plans | planId、decisionId可空、revision、quantity、price、status | portfolio；计划与事实分开 |
| reservations | accountId、planId、cashAmount/quantity、expiry | portfolio；事务更新 |
| executions | executionId、sourceKey、side、quantity、price、executedAt | portfolio；账户+sourceKey唯一 |
| cash_entries | executionId可空、type、amount、effectiveAt | portfolio；追加分录 |
| position_lots | lotId、executionId、quantity、availableDate、basis | portfolio；事实可重建 |
| correction_events | originalId、reason、replacementId、actor | portfolio；冲正链 |
| monitoring_rules/triggers | decisionId、conditionVersion、triggerKey、status | monitoring；触发键唯一 |
| experiments/evaluations | configHash、datasetId、splits、metrics、artifactRefs | experiments；确认集不可后改 |
| releases | releaseId、manifestHash、status、previousReleaseId | registry；唯一有效生产指针 |
| jobs/outbox/inbox | businessKey、lease、fencingToken、eventId、delivery | operations/notifications |

数据库迁移为每张表声明主键、唯一键、外键、数值/状态约束、查询索引与数据保留策略。所有私有对象携带归属信息，禁止根据客户端传入 ownerId直接信任授权。

## 4. 账户与账务合同

余额来自现金分录，持仓来自成交和公司行为批次投影。初期允许事务更新余额投影以便快速读取，同时保留足够事件重算验证；不建设任意业务全量事件溯源框架。

买入现金变化为负成交金额减费用；卖出为正成交金额减费用。预留单独影响可支配现金，不提前改变已结算现金。净值使用市场估值，不等于账面现金。

费用拆分 commission、stampTax、transferFee、otherFee，区分 `ACTUAL` 与 `ESTIMATED`。佣金最低收费按券商订单聚合/结算方式处理，不能每个部分成交都无条件重复最低5元。费用政策带账户和生效时间。

入金、出金、现金红利、送转、配股、退市处理、股票转入转出分别是明确类型。缺少完整历史时导入期初快照，记录来源与可核验程度，不创造虚假买入单。

系统持仓成本和券商展示成本可能口径不同，应保存口径并提供对账差异；不能为“看起来一致”覆盖真实费用。

### 4.1 首批成交冲正合同

整笔误录使用账户范围的`executions/{id}/correction-previews`与
`executions/{id}/corrections`，先生成绑定账户版本、原因、原成交和影响的
`previewHash`，提交时在账户锁内重新核验。原交割编号永久占用；
原价格、数量、费用和成交时间保留，不物理删除。新增`execution_corrections`
与唯一关联的`REVERSAL`现金分录；冲正时间为实际记录时间，不改变后续凭据录入的
业务时间下界。

FIFO批次、消耗关系和`realizedPnl`属于可重建投影，按原业务顺序剔除已冲正
成交后重算；命令回执冻结原返回值，避免盈亏重算破坏幂等响应。
冲正前独立对账必须一致；冲正后任何历史时点现金不足、后续卖出缺股或T+1
不满足均整体拒绝。历史成交列表返回`correctionId`，冲正记录单独分页读取。

本切片只提供整笔作废，不提供修改价格/数量、原编号替换、入出金冲正或倒序
历史补录；这些必须由后续原子更正/导入合同扩展，不以伪造新交割编号绕过。

### 4.2 交割单CSV预览与确认

`POST /accounts/{id}/execution-imports`接收UTF-8 CSV正文与账户版本，最多
250,000字符/500数据行。固定模板列为`instrumentId,sourceKey,side,quantityShares,
price,executedAt,commission,stampTax,transferFee,otherFee,source`，时间包含时区，
费用为实际金额。文件须按业务时间排序；不支持任意券商列名猜测。

预览在账户锁与可回滚保存点内逐笔运行实际成交写入器，回滚全部账本和outbox
后持久化预览、文件hash、标准化事实与每行NEW/DUPLICATE/ERROR。存在错误
则整个预览REJECTED，不允许隐式跳过错误行确认。预览有效期15分钟，刷新可
通过`GET /accounts/{id}/execution-imports/{importId}`恢复。

`POST .../{importId}/confirmations`以不可变预览ID作为业务幂等键，版本/有效期/
归属与独立对账通过后整批原子入账，完成态COMMITTED。相同文件可重新预览，
永久交割编号识别重复；冲正后的编号视为错误，不恢复原成交。期初持仓、
倒序历史补录、原编号更正和各券商专有格式属于后续独立合同。

## 5. Decision 合同

必填公共字段：

`schemaVersion, decisionId, accountId, instrumentId, contextId, asOf, validUntil, accountVersion, releaseId, assessmentIds, status, action, reasonCodes, evidenceIds`

动作：

| action | 含义 |
|---|---|
| BUY | 从零持仓新增 |
| ADD | 对已有持仓增加 |
| HOLD | 完整联合评估后保持当前数量 |
| REDUCE | 减少但保留部分 |
| EXIT | 目标数量为零，实际成交前仍有持仓 |
| WAIT | 未持仓或当前不行动，等待明确条件 |
| NONE | 无法完成有效联合评估，不是HOLD/WAIT的同义词 |

决策状态：

| status | 含义 | 可否形成可执行计划 |
|---|---|---|
| READY | 联合评估完成且当前合法 | 是，提交时再验证 |
| CONDITIONAL | 等待有效触发/复核 | 只能形成等待计划 |
| UNAVAILABLE | 数据、模型或Agent必要能力不足 | 否 |
| EXPIRED | 已过有效期 | 否 |
| SUPERSEDED | 已有新事实/新决策替代 | 否 |

对 BUY/ADD/REDUCE/EXIT 且 READY/CONDITIONAL 的合同，必须包含：

- currentQuantityShares、targetQuantityShares、deltaQuantityShares；
- executionPath、priceLower、priceUpper、priceBasis、triggerConditions；
- estimatedCosts、quantityRuleVersion、feePolicyVersion；
- riskSummary、modelPredictionRef、agentContributionRef；
- invalidationConditions、reviewPolicyId。

READY + HOLD/WAIT不要求构造虚假价格或非零数量。UNAVAILABLE只允许NONE且明确缺口。Schema用判别联合约束这些组合。

数量增减、资金及风险由服务端生成；客户端创建决策不能传入“我希望模型分数为多少”。用户自己的手动计划另标 `source=USER`，不伪装成系统READY。

## 6. Agent 与模型合同

AgentAssessment包括：subjectType、subjectId、agentRole、protocolVersion、sourceSnapshotId、claims、counterClaims、thesisStatus、strategyFit、evidenceIds、missingEvidence、validUntil、status。

`status=VALIDATED`仅表示合同/引用/时间等验证通过，不表示每个推断客观正确。前端文案用“证据已校验”，避免“AI判断已证实”。

Prediction包括：modelBundleId、featureSchemaVersion、contextId、actionPath、horizon、pFill、pWinGivenFill、quantiles、expectedNetReturnGivenFill、costAssumptions、support、calibrationRef。

不同头的期限、费用口径不一致时拒绝组成一个预测包。缺少 Agent 特征时不能用零填补冒充无事件，应按训练合同的 missing mask处理，并由联合能力规则判定能否完成评估。

## 7. API 通用合同

前缀 `/api/v1`。JSON字段camelCase。GET无业务写副作用。命令创建使用POST，版本更新PATCH，删除仅用于可删除对象。

成功返回 `{data, meta}`；meta含requestId、asOf、revision和必要质量状态。分页 `{data: [], page: {nextCursor, hasMore}, meta}`，游标绑定排序与过滤版本。

错误返回：

```json
{
  "error": {
    "code": "ACCOUNT_VERSION_CONFLICT",
    "message": "账户已有新成交，请更新评估后再确认计划",
    "retryable": true,
    "details": {"expectedVersion": 18, "currentVersion": 19}
  },
  "meta": {"requestId": "req_example"}
}
```

语义统一：400格式、401身份、403权限、404对象、409版本/幂等冲突、422语义不合法、429预算/限流、503依赖不可用。不得HTTP200返回“成功”同时在正文藏失败。

写命令支持Idempotency-Key，范围为用户+账户+命令类型+key。相同key相同body返回原业务结果，不同body返回409。成交sourceKey永久约束；一般幂等记录保留期覆盖客户端最大重试窗口，过期后业务唯一键仍保护重要事实。

异步命令202返回taskId、resourceLocation、statusUrl。前端依据任务终态和产物版本判断完成，不根据HTTP202弹“研究完成”。

## 8. API 目录

| 方法与路径 | 输入要点 | 输出/权限与并发 |
|---|---|---|
| POST `/sessions` | 登录凭据 | 会话cookie；限流 |
| DELETE `/sessions/current` | 当前会话 | 撤销并清缓存 |
| GET `/workspace` | accountId | 当前工作区摘要及能力状态 |
| GET `/instruments` | query、exchange、cursor | 证券列表 |
| GET `/instruments/{id}` | asOf可选 | 证券与规则能力 |
| GET `/instruments/{id}/quotes` | frequency、range | 标准行情、来源与新鲜度 |
| GET `/instruments/{id}/fundamentals` | availableAsOf | 点时财务 |
| GET `/market/overview` | asOf | 指数/宽度/行业摘要 |
| GET/POST `/watchlists` | 名称、证券列表 | 私有关注集合 |
| GET/POST `/saved-views` | 查询定义、列、排序 | 保存视图，受限筛选DSL |
| POST `/scan-runs` | strategyVersionId、scope | taskId；幂等 |
| GET `/scan-runs/{id}` | — | 阶段、coverage、失败明细 |
| GET `/opportunities` | scanId、filters、cursor | 联合/待研究状态列表 |
| POST `/research-runs` | subject、question、mode | Agent研究任务、预算 |
| GET `/research-runs/{id}` | — | 进度、产物、缺口 |
| GET `/instruments/{id}/research` | revision可选 | 论点、证据和研判 |
| POST `/theses/{id}/revisions` | expectedRevision、新内容 | 新论点版本 |
| GET `/evidence/{id}` | — | 引用、原文定位与权限受控附件 |
| GET/POST `/accounts` | 账户基础信息 | 用户自己的账户 |
| GET `/accounts/{id}/portfolio` | — | 现金/持仓/预留/风险/版本 |
| POST `/accounts/{id}/evaluations` | scope、reason、expectedVersion | 联合评估taskId |
| GET `/decisions/{id}` | — | 决策、双方贡献、完整有效性 |
| POST `/accounts/{id}/plans` | decisionId或手动计划、expectedVersion | 原子校验、计划与预留 |
| PATCH `/plans/{id}` | expectedRevision、允许的状态变化 | 新版本；不可改造成交事实 |
| POST `/accounts/{id}/executions` | 成交事实、sourceKey | 成交、账本版本、计划进度 |
| POST `/accounts/{id}/execution-imports` | 文件引用、格式、previewId | 先预览再提交，重复行报告 |
| POST `/executions/{id}/corrections` | 原因、更正事实、expectedVersion | 冲正链与更新账户 |
| POST `/accounts/{id}/cash-flows` | 入出金/分红等事实 | 分录及账户版本 |
| GET/POST `/monitoring-rules` | scope、decisionId、policyId | 显式启停；不能浏览器判触发 |
| GET `/reviews` | accountId、date、cursor | 复盘与来源 |
| GET/POST `/strategy-versions` | 注册合同/版本配置 | 草案或冻结版本 |
| POST `/experiments` | 假设、数据、split、预算 | 注册与实验任务 |
| GET `/experiments/{id}` | — | 进度、指标、失败和产物 |
| POST `/release-candidates` | 完整bundle及evaluationId | 运行发布门禁 |
| POST `/releases` | candidateId、expectedActiveReleaseId | 所有者/授权发布器原子切换 |
| POST `/releases/{id}/rollbacks` | 当前版本、目标包、原因 | 新发布记录，不改历史 |
| GET `/jobs/{id}` | — | 阶段、预算、结果引用 |
| POST `/jobs/{id}/cancellations` | 原因 | 请求取消；不虚报已撤回外部调用 |
| GET `/events` | Last-Event-ID | 按授权范围SSE |
| GET/PATCH `/settings/{scope}` | expectedRevision、允许配置 | 脱敏配置、审计 |

每个接口在实现时补齐字段schema、分页上限、错误枚举和示例。客户端从OpenAPI生成，不手抄第二套接口类型。

## 9. 状态机

### 9.1 作业

`QUEUED → RUNNING → SUCCEEDED | PARTIAL | FAILED | CANCELLED | EXPIRED`

RUNNING租约失效可返回QUEUED，但必须增加attempt与fencingToken。涉及可能重复收费的Agent步骤使用已持久化步骤结果恢复；无法确认外部调用是否完成时记录状态和费用不确定性。

PARTIAL必须附各子项结果和完成范围；决策产物本身不允许“半个READY”。

### 9.2 执行计划

`DRAFT → CONFIRMED → PARTIALLY_RECORDED → COMPLETED`

未完成计划可转CANCELLED、EXPIRED或INVALIDATED。取消只释放未执行的预留，不撤回已成交事实。COMPLETED由累计关联真实成交达到目标推进，不接受客户端直接设置。

### 9.3 监控与复核

`ARMED → OBSERVING → EVALUATING → RESOLVED`

还可终止于EXPIRED、CANCELLED、SUPERSEDED或FAILED。RESOLVED记录新的decisionId或明确不行动终态。同一triggerKey最多一个有效episode。

### 9.4 策略与发布

策略：`DRAFT → FROZEN → EVALUATED`；评估失败仍保留版本和报告。

发布：`CANDIDATE → VALIDATING → APPROVED | REJECTED`，APPROVED可进入ACTIVE，旧ACTIVE进入RETIRED；回滚创建新记录并指向已有不可变包。

## 10. 事件合同

每个事件包含eventId、eventType、schemaVersion、aggregateId、aggregateVersion、occurredAt、recordedAt、correlationId、causationId、payload与授权范围。

主要事件：`market.snapshot.ready`、`research.assessment.updated`、`research.thesis.changed`、`portfolio.changed`、`decision.published`、`plan.invalidated`、`monitor.triggered`、`execution.recorded`、`experiment.finished`、`release.activated`、`notification.created`。

消费者保存已处理eventId；同一对象按aggregateVersion防止旧事件回滚新状态。发现版本缺口时读权威快照，不盲目顺序应用。

通知页面、声音与系统推送均引用notificationId。声音只能在同一通知去重成功后触发。

## 11. 交易规则与证券能力

规则维度包括交易所、板块、证券类型、风险警示、上市阶段、交易时段、申报方式、日期、账户权限。禁止全A股一律100股、10%涨跌幅或统一盘后交易时段。

每个规则对象保存来源URL、条款、发布日期、生效日、是否暂缓实施和核验日期。2026年交易规则已有修订及暂缓条款，实施前必须按现行条文核对，不能仅复用旧投教页。

不支持的板块可查询研究，但显示“暂不支持生成执行计划”。实际成交导入以真实凭据和对账处理，不因策略不支持该板块而丢弃资产。

## 12. 数据保留、版本和导出

真实账本、决策及发布审计长期保留；原文与行情按授权和存储预算制定保留政策；任务明细与临时缓存可到期清理，但引用链必须先解除或保留必要快照。

用户删除研究对象可以归档；被历史决策引用的revision不可直接销毁。可导出账户、成交、研究与策略配置，导出包附schemaVersion、生成时间和校验清单。

Schema允许兼容新增可选字段；语义改变必须升版本。新系统不永久接受旧action参数接口；迁移适配器与日常API隔离。
