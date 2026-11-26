# 005 装备准备与案例缺口：现状复核

日期：2026-11-15  
性质：检查现有代码、既有测试和需求覆盖审计；本次未重跑测试，也未将本地演示结果写成 BSR 或正式部署验收。005 是早于完整 Spec Kit 流程的历史规格，仅有 `spec.md`；因此不能把 `speckit-converge` 的门槛视为已通过。

| 故事 | 本地证据 | 复核结论与缺口 |
| --- | --- | --- |
| 1 备货及顾客同步 | `src/fulfillment.mjs` 的逐件准备与处理人留痕；`test/fulfillment.test.mjs`、`test/preview-smoke.mjs` 的备货及顾客刷新流程 | 本地演示有实现及既有测试。正式跨端同步和隐私验收仍依赖后续部署。 |
| 2 单件占用与交付门槛 | `src/fulfillment-schema.mjs`、`src/fulfillment.mjs`、`src/domain.mjs` 的占用和交付校验；`test/fulfillment.test.mjs` | 主要门槛已实现；“重新准备释放旧占用”缺独立直接断言，应补回归。 |
| 3 顾客档案与本次技能 | `src/master-data.mjs`、`src/fulfillment-schema.mjs`、`test/fulfillment.test.mjs` | 档案及快照已实现；`src/domain.mjs` 在接口缺少 `customerSkill` 时默认“初级”，会伪造用户本次自评，须改为显式填写/拒绝并补缺项测试。 |
| 4 合同版本与见证 | `src/fulfillment.mjs`、`test/fulfillment.test.mjs`、`test/online-sign-before-payment.test.mjs`、`test/preview-smoke.mjs` | 唯一码、版本快照、打印及课程演示确认有证据；不等同合格电子签名。 |
| 5 逐件归还与退款门槛 | `src/domain.mjs`、`test/fulfillment.test.mjs`、`test/damage.test.mjs`、`test/preview-smoke.mjs` | 分批/异店归还、清洁阻断和演示退款门槛已覆盖；真实资金退回未接入。 |
| 6 租赁中途变更 | `src/amendments.mjs`、`test/fulfillment.test.mjs`、`test/preview-smoke.mjs` | 店员报价、纸质签署见证、版本/幂等和演示差价记录已实现；缺顾客本人独立确认及真实收退差价，不能称为完整正式验收。 |
| 7 人员资料与技师费率 | `src/master-data.mjs`、`test/fulfillment.test.mjs`、`test/service-upgrade.test.mjs` | 档案、合同归属、费率版本/工单快照及 0.25 小时工时已有本地证据；实际奖金政策未获批准。 |
| 8 多门店、采购和永久调拨 | `src/master-data.mjs`、`src/server.mjs`、`test/fulfillment.test.mjs`、`test/workflows.test.mjs` | 动态门店及永久调拨有本地模型与测试；真实多门店并发和部署容量未验收。 |

## 横向规则核对

- NOK、参考价值 8% 押金及历史报价快照见 `test/service-upgrade.test.mjs`；24 小时内反馈受损初评也有对应测试。商业费率、退款承诺仍待 BSR 批准。
- 005 写明“所有写入具备权限、事务及必要版本控制”，但 `src/master-data.mjs` 的新增价目、门店、采购入库、清洁确认及顾客档案等操作并未统一提供“写入与审计同一事务”和版本冲突保护的证据。核心准备、归还及变更流程有更强的事务处理，不能推断全部写入都满足同一标准。
- 005 缺 `plan.md`、`tasks.md`、质量检查表和独立的完成验收记录。后续如要正式收口，应先补可追溯计划/任务与上述缺口测试，再按真实支付、签署、组织批准和容量分别验收；不倒填未经执行的 Spec Kit 结果。

## 当前结论

八项故事的大部分本地演示流程有代码及既有测试支持；故事 2、3、6 和横向写入一致性仍有明确缺口。005 状态为**本地演示基本实现，正式验收未完成**。本复核不改变运行系统，不代替测试重跑或业务方签字。

## 后续更新（2026-11-17，015 本机修订）

本页上方保留 2026-11-15 的原复核结论。后续 `specs/015-explicit-skill-and-reprepare/` 已用显式技能字段校验关闭故事 3 的缺项默认问题，并用两单件占用、版本和失败回滚等直接断言关闭故事 2 的重新准备证据缺口。015 专项 5/5、全套 Node 测试 110/110、隔离 Chrome 27 项检查通过，包含现场必选、顾客进度/处理人与旧检查清空。详情以 015 quickstart 为准。005 故事 6 的顾客本人独立确认与真实差价清算、横向主数据写入和审计一致性仍未关闭；005 整体正式验收仍未完成。

## 后续更新（2026-11-17，016 本机自动化与隔离浏览器验证）

`specs/016-confirmed-amendment-atomic-writes/` 已为故事 6 的本地本人确认和主数据写入审计原子性建立独立规格、计划、接口契约、失败测试与任务。换装草案、顾客本人确认/拒绝、员工执行前重核及主数据事务已在本机通过专项 8/8 + 9/9、完整 Node 127/127 和隔离浏览器；浏览器还模拟草案成功但响应丢失，以原提交标识找回同一条草案。4.11 PDF 附录 I 已同步。005 的历史复核结论不回填，真实资金清算、合格电子签署、BSR 商业批准、正式容量与目标顾客 2 分钟辨识仍未验收。顾客确认仅代表本地账号动作；纸质见证及 NOK 演示差额分别留痕。
