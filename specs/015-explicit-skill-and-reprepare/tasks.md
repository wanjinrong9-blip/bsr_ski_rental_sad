# Tasks: 显式滑雪水平与重新备货释放

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[接口契约](contracts/booking-and-reprepare.md)  
**Status**: 2026-11-17 本机范围 11/11 项已完成；正式 BSR、真实交易与公开部署验收仍待后续。

## Phase 1 — Setup

- [x] T001 在 `specs/015-explicit-skill-and-reprepare/quickstart.md` 记录隔离测试规则与实施前 011 备份检查；保持真实演示库不用于破坏性测试。
- [x] T002 [P] 在 `test/explicit-skill-reprepare.test.mjs` 先写线上和现场缺失/非法水平的失败样本，以及重新准备单件释放、过期版本和失败回滚样本，保留初始红灯结果。

## Phase 2 — US1 如实记录每单滑雪水平

- [x] T003 [US1] 在 `src/domain.mjs` 的共用创建路径仅接受四个显式文本水平，修剪前后空格；缺失/空白/非文本/不支持值返回 422，且不写订单、暂留、同意或提交标识。
- [x] T004 [US1] 在 `public/fulfillment.js` 的现场开单水平选择框增加禁用的空占位项及必选校验；核对 `public/app.js` 的顾客端原有必选选择。
- [x] T005 [US1] 在 `test/explicit-skill-reprepare.test.mjs` 覆盖四级×线上/现场、同键修正重试和历史空值订单/合同快照；确认 `spec.md` SC-001/SC-002。

## Phase 3 — US2 重新准备释放单件

- [x] T006 [US2] 运行 `test/explicit-skill-reprepare.test.mjs` 的重新准备测试，核对 `src/fulfillment.mjs` 的事务/版本/权限；如有失败，仅修正相应领域操作，不引入无证据迁移。
- [x] T007 [US2] 在 `test/explicit-skill-reprepare.test.mjs` 补短说明、越权、关闭状态、双员工竞争的拒绝零副作用，以及顾客本人进度/处理人可见性；确认 SC-003/SC-004。

## Phase 4 — Integration & Evidence

- [x] T008 [P] 在 `test/preview-smoke.mjs` 或新增隔离浏览器测试验证现场未选择水平不能提交、顾客本人看到重新准备处理人/公开说明及 390px 布局。
- [x] T009 [P] 更新 `../usecase/requirement.txt`、`../usecase/系统规约.md`、`docs/需求覆盖与升级审计.md` 和 `docs/项目推进计划.md` 的 005/015 事实；受影响的 LaTeX 设计需求文档重新编译并渲染检查。
- [x] T010 运行 `node --test test/*.test.mjs`、`node test/preview-smoke.mjs` 及 015 专项/浏览器流程；在 `specs/015-explicit-skill-and-reprepare/quickstart.md` 记录 SC-001～SC-005 逐项证据与未闭合项。
- [x] T011 核对 `specs/015-explicit-skill-and-reprepare/tasks.md`、`docs/项目推进计划.md` 和 `docs/需求覆盖与升级审计.md` 的状态；只把已证实的本地能力写为通过，不宣称 BSR 或公开部署验收。

## Execution Order

T001–T002 是基础；US1 的 T003–T005 后再验 US2 的 T006–T007。T008 和 T009 在行为稳定后可并行；T010–T011 汇总。测试先于相应业务改动；同一文件操作顺序执行。无 Git 初始化、上传或公网开放。
