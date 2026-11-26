# Implementation Plan: 顾客确认换装与主数据原子写入

**Date**: 2026-11-17  
**Spec**: [spec.md](spec.md)  
**Scope**: 005 剩余两项可在本机独立验证的缺口；真实资金、合格签署与 BSR 正式价目仍待决策。

## Summary

保留现有门店换装只读报价，增加冻结草案、顾客本人会话确认和员工凭已确认草案提交三段流程；提交重核库存、合同版本与 NOK 差价，并以单事务消费草案和写合同/单件/金额。将列举的主数据写入与审计纳入同一事务，故障时全部回滚。

## Technical Context

- **Language/Version**: Node.js 24 原生服务与浏览器 JavaScript。
- **Dependencies**: 已有内建 HTTP、SQLite、测试运行器，不增加云支付/签署依赖。
- **Storage**: SQLite；新增可重复迁移的草案表与合同变更可空关联，历史行不回填。
- **Testing**: `node --test test/*.test.mjs`、隔离数据库的换装/主数据专项、`node test/preview-smoke.mjs`、候选环境拒绝回归。
- **Platform**: 本机回环演示；014 候选身份模式保持目录/价格/交易门槛关闭。
- **Concurrency**: 当前单 SQLite 写事务串行；过期合同版本和重复唯一值用数据库约束/条件更新拒绝。生产多实例容量另行验收。
- **Performance goal**: 不引入外部同步调用；草案与确认交互在本地隔离浏览器里于 2 分钟内可完成和核对。

## Constitution Check

| 原则 | 设计约束与验证 |
| --- | --- |
| I 业务价值与追溯 | 005 故事 6/横向数据一致性 → 016 FR/SC → 本人/员工流程与故障测试 → 需求台账/PDF 追溯。 |
| II 金额与政策真实性 | 保留 NOK 分列、原合同快照与演示支付文字；不改变差价公式或冒称合格签署。 |
| III 单件库存 | 提交时重算报价和实物可用性；旧单件退回、新单件借出及草案消费原子化。 |
| IV 权限与隐私 | 顾客仅本人确认；本店员工可提出/执行，技师、异店和汇总无个体读取；候选写入关闭。 |
| V 可验证与恢复 | 先验证 011 备份与隔离恢复；先写红灯，跑完整回归/浏览器，迁移可重复且历史数据不变。 |

**Gate**: 本地确认和原子性不需新增 BSR 政策；使用现有演示价目与 5 分钟窗口并保留其“待批准”标记。正式上线不得以本机验收替代组织批准。

## Project Structure

```text
src/amendments.mjs             # 只读预览、草案、本人确认、员工提交
src/fulfillment-schema.mjs     # 新表、关联与可重复迁移
src/master-data.mjs            # 列举的主数据事务
src/server.mjs                 # 路由/候选写入边界、价目事务
public/fulfillment.js          # 员工提案与顾客确认视图
public/app.js                  # 订单详情挂接及刷新
test/amendment-confirmation.test.mjs     # 隔离多角色/版本/重放
test/master-data-atomicity.test.mjs      # 审计故障/唯一竞争
test/preview-smoke.mjs                   # 实际浏览器及 390px
specs/016-confirmed-amendment-atomic-writes/
../usecase/requirement.txt
../usecase/系统规约.md
../output/BSR设计需求文档_LaTeX/
```

测试文件名可随现有命名调整；职责与可验证结果不变。

## Implementation Order

1. 验证 `data/bsr.sqlite` 的 011 备份、完整性与隔离恢复。所有破坏性测试使用临时库；核对候选旧来源不被污染。
2. 为未确认/已拒绝/过期/跨账号/跨店/重复/旧版本/库存变化写换装失败测试；为七类主数据写入设置审计失败注入红灯，保存原始结果。
3. 在 `upgradeFulfillment` 约定内建草案表、唯一提交标识及 `contract_adjustments.proposal_id` 可空关联。迁移重复运行、老行读取和候选空库分别测试。门店名称唯一索引仅在核对历史重名与业务语义后增加。
4. 建立草案创建/查询/本人确认与拒绝路由；保留 `/quote` 只读。新候选 POST 路由纳入交易关闭守卫。页面展示明确的本人确认、纸质见证和演示收退三种不同事实。
5. 修改原提交：`proposalId` 必填，从冻结草案内容重算，不信任可编辑提交体；同事务检查确认与期效、写变更/合同/单件/金额/审计通知并消费。旧历史变更只读兼容。
6. 六个主数据函数及价目 POST 用事务包装“业务写入+审计/适用通知”，保留岗位与对象限制；员工资料原事务只回归。当前价目同日多版本不在 016 擅改，需单独政策决定。
7. 完整自动测试和隔离浏览器两角色流程，包括 390px、网络重试、历史展示；更新需求台账、系统规约、覆盖表与 LaTeX PDF，并渲染受影响页面。只据实标注本机验收。

## Rollback and Migration Safety

新表/列和索引以可重复迁移引入；历史 `contract_adjustments` 无 `proposal_id` 的事实不变。应用回滚不得删除新确认或将新合同冒充旧签署；回退后应暂停办理换装，直到应用与迁移版本兼容。生产多实例、真实身份核验、外部资金与电子签署仍另行计划。
