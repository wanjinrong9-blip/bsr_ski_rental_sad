# Data Model: 015

**无数据库结构迁移。** 现有订单及准备表继续作为唯一事实来源。

| 概念 | 现有字段/关系 | 本次不变量 |
| --- | --- | --- |
| 顾客本次滑雪水平 | `reservations.customer_skill`；订单属于一名顾客 | 新单只写入明确的初级/中级/高级/专家+；历史 `NULL` 不回填。 |
| 装备固定技能 | `units.skill_code`、`variants.skill` | 与顾客本次自评独立，不由其推断。 |
| 合同快照 | `contracts.snapshot_json` → 一个订单的版本 | 新合同读取订单原水平；历史空值显示“历史未登记”，已存在快照不改。 |
| 准备单 | `preparations.reservation_id`、`status`、`assigned_to`、`version`、`public_note` | 重新准备将未交付状态退回 PICKING，版本只增加一次。 |
| 单件有效占用 | `preparation_units(reservation_id,item_id,unit_id,active)` | 重新准备后旧单有效行数为零；有效单件唯一索引仍防同件双占用。旧检查标记不得复用。 |
| 准备事件/通知 | `preparation_events`、`notifications` | 成功记录处理人、时间与公开说明；拒绝时没有新事件/通知。 |
| 提交标识与同意 | `reservation_requests`、`damage_consents` | 无效技能不产生订单、暂留、提交标识或同意行；修正后同键可首次成功。 |

状态转移：未交付准备单 `CHECKING/READY/BLOCKED/PICKING → PICKING`（重新准备）；`HANDED_OVER/CANCELLED` 不可重启。失效旧绑定、撤销 READY 资格、版本/事件/通知在同一事务完成；失败全部回滚。
