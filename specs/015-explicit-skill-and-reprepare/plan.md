# Implementation Plan: 显式滑雪水平与重新备货释放

**Date**: 2026-11-17  
**Spec**: [spec.md](spec.md)  
**Scope**: 补齐 005 的两个可独立验证的本地缺口；不改变商业价格、支付或签署政策。

## Summary

预约创建共用 `createReservation`，在写入订单之前验证顾客本次滑雪水平，不再以“初级”代替缺失值。现场开单表单增加必选占位项，使店员主动向顾客询问。重新准备沿用现有事务和版本机制，先补直接回归，只有测试证明有缺陷时才修改业务代码。

## Technical Context

- **Language/Version**: Node.js 24、浏览器原生 JavaScript。
- **Dependencies**: Node 内建 `http`、`sqlite` 与测试运行器；不增加依赖。
- **Storage**: 现有 SQLite `reservations.customer_skill`、`preparations`、`preparation_units`、`preparation_events`；无结构迁移。
- **Testing**: `node --test test/*.test.mjs`、`node test/preview-smoke.mjs`、隔离数据库的新测试。
- **Platform**: 现有本机回环演示；014 候选预约继续关闭。
- **Performance/scale**: 不增加远程调用；沿用现有单库事务和单件有效占用唯一索引。生产多门店容量另行验收。

## Constitution Check

| 原则 | 设计约束与证据 |
| --- | --- |
| I 业务价值与追溯 | 005 故事 2/3 → 015 FR/SC → 订单及备货测试 → 需求覆盖审计。 |
| II 金额与政策真实性 | NOK 报价、8% 押金、原合同与演示支付不改；不声称 BSR 批准。 |
| III 单件库存 | 重新准备释放旧有效占用，下一单重查门店、清洁、维修和可用状态。 |
| IV 权限与隐私 | 本人顾客只见本人进度；原店经办/经理按对象授权，失败无业务副作用。 |
| V 可验证与恢复 | 实施前验证本机备份；先运行失败测试，再修复，最后运行全套与浏览器回归。 |

**Gate**: 无外部服务或组织政策待决项阻断此本地修正；正式业务签字仍单独待办。

## Project Structure

```text
src/domain.mjs                    # 两个预约入口共用的业务验证
src/fulfillment.mjs               # 重新备货事务与版本行为（先测试，必要时修改）
public/fulfillment.js             # 现场技能显式选择
public/app.js                     # 顾客在线必选控件（核对，不预设改动）
test/explicit-skill-reprepare.test.mjs  # 隔离合同/占用回归
test/preview-smoke.mjs            # 多角色浏览器回归
specs/015-explicit-skill-and-reprepare/ # 规格、设计、任务、验收
../usecase/requirement.txt
../usecase/系统规约.md
../output/BSR设计需求文档_LaTeX/ # 课程设计需求文档源
```

## Execution

1. 将线上/现场缺失及非法水平的测试先运行并记录失败；重新备货回归应展示当前行为。
2. 在共用创建路径中只接受四个显式文本值，前后空格规范化；拒绝返回 422，事务回滚。
3. 现场表单提供未选占位项与浏览器必选校验。核对顾客端原有必选行为。
4. 补足合法四等级×两入口、幂等重试、历史空值、备货越权/版本/失败回滚证据。
5. 运行全套自动测试、隔离浏览器与 390px 页面检查；更新需求覆盖、系统规约及受影响的设计文档，渲染检查 PDF。

## Rollback

无数据库迁移。若校验导致旧客户端提交失败，恢复应用代码即可；已存在订单及合同保持原值，不回填空技能。修改前演示库备份已通过完整性、外键和隔离恢复检查；新测试只使用临时库。
