# Tasks: 顾客线上先签合同后确认付款

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[checkout-sequence.md](contracts/checkout-sequence.md)。  
**Status**: 本地实施与验收完成（2026-10-30）；勾选对应代码、测试和文档证据。路径相对 `bsr-app/`。

## Phase 1: Setup

- [x] T001 记录 `src/domain.mjs`、`src/fulfillment.mjs`、`src/server.mjs`、`public/app.js`、`public/fulfillment.js` 和测试文件的当前摘要，并备份运行 SQLite 到 `.gitignore` 排除的 `data/backups/` 恢复目录；不触碰现有业务记录。
- [x] T002 在 `test/online-sign-before-payment.test.mjs` 建隔离数据库的顾客、员工、经理会话与预约夹具，验证既有“未签可付”行为确实失败于目标断言。

## Phase 2: Foundational

- [x] T003 在 `src/fulfillment.mjs` 拆分合同实际发起人与门店经办责任人的参数语义；新合同快照保存 `ONLINE_SELF_SERVICE` / `COUNTER_MANUAL` 来源，旧 JSON 与 hash 不回写。
- [x] T004 在 `src/domain.mjs` 为 `HOLD` 预约选取本店租赁专员或现行有权限的经理作为经办责任人；无合格人时返回明确合同开具阻塞原因，不伪造姓名。

## Phase 3: US1 顾客先签后付 (P1)

**Independent test**: 新线上订单无合同/未签付款均拒绝，签当前版后成功且两类演示流水各一笔。

- [x] T005 [US1] 在 `test/online-sign-before-payment.test.mjs` 加无合同、未签、最新已签、错摘要、过期、重复付款及准备任务断言；先运行确认旧代码不能通过。
- [x] T006 [US1] 在 `src/fulfillment.mjs` 与 `src/server.mjs` 允许顾客本人为有效 `HOLD` 首次生成合同；保留员工现场开单权限与合同对象授权。
- [x] T007 [US1] 在 `src/domain.mjs` 的付款事务中先校验当前合同版本已签、暂留和宽限资格，再写 RENT/DEPOSIT 演示流水与准备任务；拒绝失败或重复请求。
- [x] T008 [US1] 在 `public/app.js` 与 `public/fulfillment.js` 让顾客 `HOLD` 订单按无合同、待签、已签显示相应单一主动作，签署后刷新到付款，标明演示性质。

## Phase 4: US2 门店人工签付与归属 (P2)

**Independent test**: 现场先付款拒绝，纸质签署见证后付款；顾客自助合同不伪计员工业绩。

- [x] T009 [US2] 在 `test/online-sign-before-payment.test.mjs` 增现场纸质见证、顾客/员工发起来源、`reservations.created_by` 和年度业绩归属断言。
- [x] T010 [US2] 在 `src/fulfillment.mjs`、`src/server.mjs` 保留现场签署与付款顺序，并保证自助合同实际发起人、门店经办人和员工业绩字段各自准确。
- [x] T011 [US2] 在 `public/fulfillment.js` 显示自助/现场来源、发起人及经办员工；在 `public/app.js` 现场付款说明中继续要求纸质见证。

## Phase 5: US3 历史与异常 (P3)

**Independent test**: 老订单值不变，跨账号、过期、旧版本与并发重复提交拒绝且无额外流水。

- [x] T012 [US3] 在 `test/online-sign-before-payment.test.mjs` 加历史已付未签、跨账号、过期、重复/并发付款和无可负责员工的回归；核对合同 hash、金额和流水不变。
- [x] T013 [US3] 在 `public/app.js` 与 `public/fulfillment.js` 给过期、负责人缺失、版本变化提供可执行的下一步提示；旧已付订单仍可查看原合同并完成交付前签署。
- [x] T014 [US3] 在 `test/fulfillment.test.mjs`、`test/workflows.test.mjs`、`test/damage.test.mjs`、`test/rental-policy.test.mjs`、`test/order-alerts.test.mjs`、`test/service-upgrade.test.mjs` 与 `test/preview-smoke.mjs` 将旧“先付后签”夹具调整为新签付顺序，不放宽断言。

## Phase 6: Polish and documentation

- [x] T015 在 `test/preview-smoke.mjs` 实操顾客生成合同、本人确认、付款、备货同步和 390px 布局；运行全部 Node 与浏览器回归，记录通过数与异常。
- [x] T016 在 `../usecase/系统规约.md`、`../usecase/需求追溯矩阵.md`、`../output/BSR设计需求文档_LaTeX/updates/` 同步 UC-05 及相关序列、状态、付款文案，编译 PDF 并视觉复核受影响页。
- [x] T017 在 `README.md`、`docs/需求覆盖与升级审计.md` 与 `../usecase/交付检查清单.md` 更新本地实现/外部服务差距及测试证据，确认没有宣称真实付款或签章。

## Dependencies and implementation strategy

T001–T004 是共同前置；US1 为 MVP，完成 T005–T008 后独立验收。US2 沿用 US1 的统一付款门槛，US3 最后处理历史与异常。T014 必须在后端目标行为确定后执行，避免测试继续依赖旧顺序。T016 的图文修订依赖已验证代码。全部任务完成并标 `[x]` 前不把本功能报告为已实现。

## 验收证据（2026-10-30）

- `baseline-sha256.txt` 保存改动前摘要；运行 SQLite 的备份在忽略提交的 `data/backups/bsr-before-008-20261030.sqlite`。自动测试使用独立临时数据库，未批量改写运行库。
- `node --test test/*.test.mjs`：41/41 通过，含线上未签拒付、现场纸质见证、跨账号、过期、经办人缺失、并发重复、历史数据不变与员工归属。
- `node test/preview-smoke.mjs`：顾客生成并确认合同后付款，门店备货与交付、跨角色同步及 390px 布局通过。
- 设计需求 PDF v4.2 为 66 页 A4；UC-05/06、S-UC05/06、ST-ORDER 和 E-05/06 已同步并复核受影响页面。真实支付与合格电子签署仍属生产缺口。
