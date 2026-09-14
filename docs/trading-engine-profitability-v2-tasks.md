# Tasks: 交易价值模型与可验证执行架构 V2

状态：IN PROGRESS（Tasks 1-12 已完成）。
依赖：[规格](./trading-engine-profitability-v2-spec.md)与[实施计划](./trading-engine-profitability-v2-plan.md)。

## Phase 1：合同与价格绑定

### Task 1：记录ADR-006（已完成）

**Description:** 固化复核V2语义、风险档、四段时间用途和一次性最终确认规则。

**Acceptance criteria:**
- [x] ADR明确`pFill`、条件收益、成交前机会价值、Q10和R分母。
- [x] ADR明确三种风险档及生产授权边界。
- [x] ADR明确最终确认集失败后不得在同段重选。

**Verification:** `git diff --check`

**Dependencies:** None

**Files likely touched:** `docs/decisions/ADR-006-trading-value-v2.md`

**Estimated scope:** XS

### Task 2：冻结复核特征V2合同（已完成）

**Description:** 扩充特征合同，加入价格风险、费用、交易规则和每个可选特征的缺失掩码。

**Acceptance criteria:**
- [x] JSON合同包含版本、稳定顺序、单位和必需/可选说明。
- [x] 缺失值与真实0在编码后不同。
- [x] 不修改通用36维`/predict`合同。

**Verification:** `node --test test/opportunity-review-features.test.js`

**Dependencies:** Task 1

**Files likely touched:** `qlib-service/contracts/opportunity-review-features.json`, `shared/opportunityReviewFeatures.js`, `test/opportunity-review-features.test.js`

**Estimated scope:** M

### Task 3：实现规范价格合同哈希（已完成）

**Description:** 对模型实际评分的入场、止损、风险分母、费用和退出版本生成跨语言稳定哈希。

**Acceptance criteria:**
- [x] JS/Python对金样生成相同哈希。
- [x] 字段顺序不影响哈希，价格或费用变化必然改变哈希。
- [x] 非法价格和非有限数值失败关闭。

**Verification:** `node --test test/review-price-contract.test.js && PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_review_price_contract`

**Dependencies:** Task 2

**Files likely touched:** `shared/reviewPriceContract.js`, `qlib-service/decision_engine/heads/review_contract.py`, `test/review-price-contract.test.js`, `qlib-service/tests/test_review_price_contract.py`

**Estimated scope:** M

### Task 4：绑定服务端评分请求和结果（已完成）

**Description:** 先构造最终价格计划，再生成特征并调用量化服务；返回哈希不一致时拒绝使用分数。

**Acceptance criteria:**
- [x] 请求携带V2版本、价格合同和哈希。
- [x] 结果只绑定原请求合同，错版或错哈希返回不可执行状态。
- [x] 切换股票或重算价格不会复用旧评分。

**Verification:** `node --test test/action-value-client.test.js test/decision-engine-contract.test.js`

**Dependencies:** Task 3

**Files likely touched:** `api/_decision_orchestrator.js`, `api/_action_value_client.js`, `test/action-value-client.test.js`, `test/decision-engine-contract.test.js`

**Estimated scope:** M

### Task 5：升级模型注册表兼容门禁（已完成）

**Description:** 只有包含V2特征、价格合同、标签、退出和风险元数据的模型包可加载。

**Acceptance criteria:**
- [x] V1或缺字段模型返回确定性`NOT_READY`。
- [x] 模型文件和元数据哈希完整校验。
- [x] 热更新失败不保留半加载状态。

**Verification:** `PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_review_inference qlib-service.tests.test_review_model_upload`

**Dependencies:** Task 3

**Files likely touched:** `qlib-service/decision_engine/review_registry.py`, `qlib-service/decision_engine/review_inference.py`, `qlib-service/tests/test_decision_review_inference.py`, `qlib-service/tests/test_review_model_upload.py`

**Estimated scope:** M

## Checkpoint A：合同闭环

- [x] Tasks 1-5全部通过。
- [x] JS/Python金样一致。
- [x] 旧模型失败关闭且不影响账本硬止损。
- [x] `npm run harness:lifecycle`通过。

## Phase 2：事件、标签与时间隔离

### Task 6：拆分完整事件与条件收益数据集（已完成）

**Description:** 保留所有合法触发事件用于成交标签；只在可核验成交或明确反事实结算样本上生成条件收益标签。

**Acceptance criteria:**
- [x] 未成交、拒绝、撤销和未成熟事件不丢失。
- [x] 未成交事件没有伪造`netR=0`。
- [x] 标签记录真实/模拟来源及退出合同版本。

**Verification:** `PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_review_dataset`

**Dependencies:** Task 2

**Files likely touched:** `qlib-service/decision_engine/training/review_dataset.py`, `qlib-service/tests/test_decision_review_dataset.py`, `scripts/lib/opportunity-history-backfill.mjs`, `test/opportunity-history-backfill.test.js`

**Estimated scope:** M

### Task 7：按真实标签区间实现四段分区（已完成）

**Description:** 用`labelStartAt`/`labelEndAt`清除跨界样本，输出训练、校准、选择和最终确认四段。

**Acceptance criteria:**
- [x] 任一结果区间跨界样本被purge。
- [x] 同股同事件路径保持同组，不能跨分区。
- [x] 样本不足明确阻断，不缩短embargo凑数。

**Verification:** `PYTHONPATH=qlib-service python3 qlib-service/test_time_splits.py && PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_review_training`

**Dependencies:** Task 6

**Files likely touched:** `qlib-service/time_splits.py`, `qlib-service/decision_engine/training/review_dataset.py`, `qlib-service/tests/test_time_splits.py`, `qlib-service/tests/test_decision_review_training.py`

**Estimated scope:** M

### Task 8：增加点时不可变回归（已完成）

**Description:** 验证增加未来行情、财报修正或后续成交不会改变历史特征、标签和分区。

**Acceptance criteria:**
- [x] 前缀回放与完整回放的历史段逐字一致。
- [x] 后续财报修正不回填至历史特征。
- [x] 标签成熟前不进入任何监督目标。

**Verification:** `node --test test/opportunity-history-backfill.test.js test/point-in-time-invariance.test.js`

**Dependencies:** Tasks 6-7

**Files likely touched:** `test/point-in-time-invariance.test.js`, `test/opportunity-history-backfill.test.js`, `scripts/lib/opportunity-history-backfill.mjs`

**Estimated scope:** S

## Checkpoint B：因果数据

- [x] Tasks 6-8全部通过。
- [x] 数据漏斗按状态、来源、日期和策略可审计。
- [x] 旧191日数据只标记为研究回归集。

## Phase 3：模型与选择门禁

### Task 9：训练成交概率头（已完成）

**Description:** 使用完整事件样本训练并校准真实成交概率，替换固定`pFill=1`。

**Acceptance criteria:**
- [x] 输出校准后的`pFill`和Brier/校准曲线指标。
- [x] 涨跌停、无下一成交K线和超时事件参与负样本。
- [x] 无成交标签时训练失败，不回退常数1。

**Verification:** `PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_review_training`

**Dependencies:** Checkpoint B

**Files likely touched:** `qlib-service/decision_engine/training/review_ensemble.py`, `qlib-service/decision_engine/training/review_dataset.py`, `qlib-service/decision_engine/review_inference.py`, `qlib-service/tests/test_decision_review_training.py`

**Estimated scope:** M

### Task 10：训练条件收益与直接净R消融（已完成）

**Description:** 对已成交样本训练胜率、正负幅度和直接净R挑战头，固定消融协议。

**Acceptance criteria:**
- [x] 输出`pWinGivenFill`、条件正负幅度和`expectedNetRGivenFill`。
- [x] 直接净R模型与分解模型在选择段比较。
- [x] 最终确认段不重新选择两者。

**Verification:** `PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_review_training qlib-service.tests.test_decision_review_bakeoff`

**Dependencies:** Task 9

**Files likely touched:** `qlib-service/decision_engine/training/review_ensemble.py`, `qlib-service/decision_engine/training/review_bakeoff.py`, `qlib-service/decision_engine/heads/review.py`, `qlib-service/tests/test_decision_review_bakeoff.py`

**Estimated scope:** M

### Task 11：实现逐样本尾损与支持度门禁（已完成）

**Description:** 训练Q10并根据训练支持范围、缺失模式和特征漂移给出可执行性状态。

**Acceptance criteria:**
- [x] Q10为逐样本预测，不使用全局尾均值冒充。
- [x] OOD和关键缺失不能固定为false。
- [x] 尾部覆盖率不合格时阻断发布。

**Verification:** `PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_review_inference qlib-service.tests.test_decision_review_training`

**Dependencies:** Task 10

**Files likely touched:** `qlib-service/decision_engine/training/review_ensemble.py`, `qlib-service/decision_engine/review_inference.py`, `qlib-service/decision_engine/heads/review.py`, `qlib-service/tests/test_decision_review_inference.py`

**Estimated scope:** M

### Task 12：分离选择集与一次性最终确认（已完成）

**Description:** 候选成员、阈值和消融模型只在选择段确定；确认段仅评估冻结包。

**Acceptance criteria:**
- [x] 发布审计记录选择数据哈希、候选哈希和确认数据哈希。
- [x] 同一确认数据哈希第二次择优被拒绝。
- [x] 失败保持当前生产Manifest。

**Verification:** `PYTHONPATH=qlib-service python3 -m unittest qlib-service.tests.test_decision_release qlib-service.tests.test_decision_release_upload`

**Dependencies:** Tasks 7, 10-11

**Files likely touched:** `qlib-service/decision_engine/training/release.py`, `qlib-service/decision_engine/training/review_bakeoff.py`, `qlib-service/tests/test_decision_release.py`, `qlib-service/tests/test_decision_release_upload.py`

**Estimated scope:** M

## Checkpoint C：可信模型

- [ ] Tasks 9-12全部通过。
- [ ] 预测语义、模型元数据和API响应一致。
- [ ] 选择与确认没有数据复用。
- [ ] 未过门禁模型不能发布。

## Phase 4：风险档与账户同源回放

### Task 13：实现共享风险档合同

**Description:** 将三种风险档集中定义并加入账户风险计算，消除散落常数。

**Acceptance criteria:**
- [ ] `BASELINE`复现当前风险行为。
- [ ] `ELEVATED_RESEARCH`只能由研究运行显式选择。
- [ ] `ABSOLUTE_CAP`无法自动进入生产配置。

**Verification:** `node --test test/account-risk-profile.test.js test/account-risk-budget.test.js`

**Dependencies:** Task 1

**Files likely touched:** `shared/accountRiskProfiles.js`, `shared/accountRiskBudget.js`, `shared/accountCircuitBreaker.js`, `test/account-risk-profile.test.js`, `test/account-risk-budget.test.js`

**Estimated scope:** M

### Task 14：建立脱敏决策包和同源回放适配器

**Description:** 从版本化决策包恢复生产纯内核输入，并输出动作、价格、数量和阻断原因。

**Acceptance criteria:**
- [ ] 决策包不包含账号、令牌或完整账户快照。
- [ ] 线上纯内核与回放结果逐字段一致。
- [ ] 输入版本不匹配时失败关闭。

**Verification:** `node --test test/decision-replay.test.js && npm run harness:lifecycle`

**Dependencies:** Tasks 4-5, 13

**Files likely touched:** `shared/reviewDecisionPacket.js`, `backtest/decision/replay.mjs`, `test/decision-replay.test.js`, `harness/cases/decision-lifecycle.json`

**Estimated scope:** M

### Task 15：接入真实账户账本和撮合

**Description:** 将同源动作接入T+1、费用、滑点、资金占用、涨跌停、跳空与跟踪退出模拟。

**Acceptance criteria:**
- [ ] 未完成订单占用现金，未成交卖出不释放现金。
- [ ] 日终现金、持仓、费用和权益按分复算。
- [ ] 2倍滑点和下一开盘退出压力情景可重复运行。

**Verification:** `node --test test/decision-account-backtest.test.js && npm run harness:execution && npm run harness:portfolio`

**Dependencies:** Task 14

**Files likely touched:** `backtest/decision/accountEngine.mjs`, `backtest/decision/ledgerAudit.mjs`, `test/decision-account-backtest.test.js`

**Estimated scope:** M

### Task 16：运行风险收益曲线

**Description:** 先运行`BASELINE`，通过后才运行`ELEVATED_RESEARCH`；`ABSOLUTE_CAP`只检查硬限制。

**Acceptance criteria:**
- [ ] 基线未通过时研究档结果标为未授权比较。
- [ ] 报告收益、回撤、尾损、资金利用率、费用和集中度。
- [ ] 不把风险等比例放大称为模型提升。

**Verification:** `node backtest/decision/run-profitability-v2.mjs`

**Dependencies:** Tasks 12, 15

**Files likely touched:** `backtest/decision/run-profitability-v2.mjs`, `backtest/decision/experiment-v2.json`, `test/decision-profitability-v2.test.js`

**Estimated scope:** M

## Checkpoint D：账户级验收

- [ ] Tasks 13-16全部通过。
- [ ] 基线与高风险档的差异可归因。
- [ ] 账户回放、账本审计和模型报告一致。
- [ ] 用户审阅离线结果后才能进入部署。

## Phase 5：发布、部署与前向记录

### Task 17：集成CI和每日重训门禁

**Description:** 把V2合同、四段时间用途和风险报告加入现有流水线。

**Acceptance criteria:**
- [ ] 训练超时或数据不足显式失败。
- [ ] 确认失败不执行发布步骤。
- [ ] 日报记录数据、模型、风险档和发布裁决哈希。

**Verification:** `npm run harness:ci`及GitHub Actions手动运行

**Dependencies:** Checkpoint D

**Files likely touched:** `.github/workflows/daily-retrain.yml`, `package.json`, `qlib-service/publish_model_retrain_report.py`, `qlib-service/tests/test_publish_model_retrain_report.py`

**Estimated scope:** M

### Task 18：原子部署与测试账号验收

**Description:** 仅在全部门禁通过后部署量化服务和主FC，执行测试账号闭环。

**Acceptance criteria:**
- [ ] 量化模型状态、版本和合同哈希正确。
- [ ] 主FC行情和AI冒烟HTTP 200。
- [ ] 测试账号使用指定fixture；生产账号仅只读。

**Verification:** 量化接口只读检查、FC冒烟、`HARNESS_NICK=... npm run harness:advice`

**Dependencies:** Task 17及离线发布通过

**Files likely touched:** 无计划源码修改；部署生成物不提交

**Estimated scope:** S

### Task 19：冻结前向观测与最终报告

**Description:** 固定模型、风险档和决策合同，记录至少60交易日运行结果。

**Acceptance criteria:**
- [ ] 每次决策、拒绝、成交和退出可追溯。
- [ ] 公开收益、回撤、费用、集中度和模型校准。
- [ ] 60日窗口不被表述为长期盈利保证。

**Verification:** `npm run harness:export -- --input <sanitized-failure>`及只读报告校验

**Dependencies:** Task 18

**Files likely touched:** `docs/`中的版本化验收报告；必要时新增脱敏回归case

**Estimated scope:** S

## Final Gate

- [ ] 全部软件正确性标准通过。
- [ ] `BASELINE`独立确认期费后收益及同风险超额收益门禁通过。
- [ ] 高风险档未被用于掩盖基线负期望。
- [ ] 未经人工再次批准，`ABSOLUTE_CAP`不进入生产。
- [ ] 失败时维持生产失败关闭或现役合格版本。
