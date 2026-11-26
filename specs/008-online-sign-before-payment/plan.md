# Implementation Plan: 顾客线上先签合同后确认付款

**Branch**: `008-online-sign-before-payment`（逻辑标识，无 Git 分支） | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

## Summary

沿用现有订单、合同和演示付款模型：顾客本人可在暂留期间发起当前合同、阅读并确认；付款服务在任何流水写入前统一检查当前合同签署和暂留有效性。页面以“生成合同→签署→付款→备货”为一条连续路径，现场纸质见证流程保持原义。历史已付订单不迁移或重写。

## Technical Context

**Language/Version**: Node.js 24 原生 ES modules、浏览器原生 JavaScript。  
**Primary Dependencies**: 项目内 `src/domain.mjs`、`src/fulfillment.mjs`、`src/server.mjs`、`public/app.js`、`public/fulfillment.js`；无新增第三方运行依赖。  
**Storage**: 现有 SQLite `reservations`、`contracts`、`payments`、`preparations`、`audit_log`；只新增合同 JSON 快照字段 `channel`，无需 DDL。  
**Testing**: Node `test/*.test.mjs`，隔离数据库的 `test/preview-smoke.mjs`，人工查看顾客和店员的关键页面。  
**Target Platform**: 本地 Web 预览，390px 手机宽度及桌面。  
**Project Type**: 现有单体 Web 服务和静态前端。  
**Performance Goals**: 不新增跨网络外部服务；暂留期与服务端检验保持原有行为。正式并发容量目标待 BSR 测量。  
**Constraints**: NOK 合同金额不变；真实支付、退款和合格电子签章不在本次范围；所有签署/付款仅课程演示。  
**Scale/Scope**: 顾客自助订单和现场订单两条路径、当前与历史合同、六角色权限。

## Constitution Check

| 原则 | 计划中的核对 |
| --- | --- |
| I 可追溯 | 对应 FR-F02/FR-F03、UC-05、合同序列/状态、008 验收与代码回归；实施后更新设计需求文档及审计。 |
| II 合同和资金真实性 | 合同快照、版本和 NOK 金额不改；所有页面明确“演示”，真实服务列待 BSR 决策。 |
| III 单件与跨店一致 | 本次不改库存；付款后现有准备任务继续校验单件。 |
| IV 最小权限 | 顾客只操作本人订单；员工不能做顾客本人电子确认；合同打印继续对象授权。 |
| V 可验证与恢复 | 无 DDL；对运行数据库先备份再操作。自动测试覆盖拒绝、重复、过期、历史和现场；浏览器复核关键路径。 |

**Gate**: 计划不需要原则豁免。正式签署和付款接入属于后续独立规格。

## Project Structure

```text
specs/008-online-sign-before-payment/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/checkout-sequence.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
src/domain.mjs                 # 付款统一门槛
src/fulfillment.mjs            # 顾客发起合同、发起人/经办人语义
src/server.mjs                 # 合同路由与职责校验
public/app.js                  # 订单主要动作及顺序文案
public/fulfillment.js          # 合同入口、来源与签署信息
test/*.test.mjs                # 服务器回归
test/preview-smoke.mjs         # 多角色浏览器路径
../usecase/系统规约.md
../output/BSR设计需求文档_LaTeX/updates/
docs/需求覆盖与升级审计.md
```

## Phase 0: Research decisions

见 [research.md](research.md)。核心是把线上顾客设为合同实际发起人，把门店责任员工单独放在合同快照；付款统一在领域层检查最新版本已签。新门店无人可负责时不编造员工。旧订单不改写。

## Phase 1: Design and contracts

数据模型与状态见 [data-model.md](data-model.md)，接口前后置见 [contracts/checkout-sequence.md](contracts/checkout-sequence.md)。本阶段不新增表；历史兼容通过保留旧 JSON、旧支付流水和旧 `reservations.created_by` 实现。

## Implementation order

1. 先补新线上签付及越权、过期、重复提交的服务器回归，确认它们在旧实现上失败。
2. 修改合同生成与付款领域门槛；在事务中先校验再写演示资金，并核查并发/幂等。
3. 修改顾客订单与合同界面，使 `HOLD` 按合同状态显示一个明确主动作；支付按钮只在当前版本已签时出现。现场路径保留纸质见证。
4. 更新原先“先付后签”的测试助手和浏览器流程；实测桌面与 390px 手机端以及跨角色同步。
5. 更新系统规约、LaTeX 相关 UC/序列/状态、需求覆盖审计和 README；重编 PDF 并审受影响页面。v4.1 的审阅图像保存在项目根目录 `output/BSR设计需求文档_LaTeX/review/v4.1/`，现行交付版为 v4.2。

## Rollback and verification

- 代码变更前记录涉及文件 SHA-256，并把运行数据库复制到 `.gitignore` 排除的 `data/backups/`；不对旧订单批量变更。代码回退需按变更记录逆向恢复并在隔离副本验证，运行数据可从备份恢复。
- 完成门槛：全套 Node 回归与隔离浏览器测试通过；旧历史数据金额/状态/hash 不变；新单未签付款 0 成功；重复付款 0 新增；顾客与员工页面提示一致。
- 系统只实现课程演示顺序，外部服务、业务政策、电子签署有效性与生产容量仍需独立验收。
