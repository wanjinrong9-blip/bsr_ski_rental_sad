# Data Model: 016

## 换装草案

新表 `amendment_proposals`（命名可按现有迁移约定调整）承载一次可确认的换装意向。

| 字段 | 约束/语义 |
| --- | --- |
| `id` | 恒定主键。 |
| `reservation_id` | 非空外键，草案所属订单；顾客只通过本人订单访问。 |
| `created_by` | 非空员工外键；与订单门店授权核对。 |
| `request_key`、`payload_hash` | 员工提出时的幂等标识与规范化输入摘要；`(created_by,request_key)` 唯一，同键异内容冲突。 |
| `base_version`、`quote_hash`、`quote_json` | 原合同版本、精确报价摘要和包含 NOK/单件/押金分列的不可变草案快照。 |
| `input_json`、`return_store_id` | 规范化增减项、有效时间及当前办理门店，最终提交时重核。 |
| `status` | `PENDING`、`CONFIRMED`、`REJECTED`、`SUPERSEDED`、`CONSUMED`；过期可由当前时间推导为 `EXPIRED`，读取不需写入。 |
| `created_at`、`expires_at` | 服务器时间；截止不得晚于现有报价可复算的 5 分钟窗口。 |
| `confirmed_by`、`confirmed_at`、`rejected_by`、`rejected_at` | 只由本人顾客会话填写；员工不可代写。拒绝与确认互斥。 |
| `consumed_at`、`consumed_adjustment_id` | 成功换装时在同一事务登记，消费后不能再提交。 |

`contract_adjustments` 新增可空且唯一的 `proposal_id` 外键：新变更必须关联一条已确认草案；历史行保留 `NULL`，原 `reference` 唯一规则与合同快照不改。一个草案最多形成一条合同变更。

## 状态与不变量

```text
PENDING ──顾客确认──> CONFIRMED ──门店执行──> CONSUMED
   │                       │
   ├─顾客拒绝──> REJECTED   └─过期/合同变化──> 有效状态 EXPIRED
   ├─员工更正──> SUPERSEDED
   └─截止时间──> 有效状态 EXPIRED
```

- 只有 `PENDING` 且未过期、版本仍一致才可本人确认/拒绝；同动作重复返回既有结果，不追加审计。
- 只有 `CONFIRMED`、未过期且订单版本/单件/价目仍一致才可最终提交。成功时草案消费、旧单件归还、新单件借出、订单金额、合同新版本、审计/通知和变更记录同事务完成。
- 员工更正只可取代 `PENDING`；已确认且未到期需顾客先拒绝/取消或自然失效，避免确认后静默变更。
- 读取按当前时间计算 `EXPIRED`，不可在 GET 中偷偷更改记录；店员下一次提出时可在事务内清理过期状态。
- 顾客只见本人订单草案及公开金额/单件；员工仅本店，技师与汇总岗位没有个体访问路径。

## 主数据及审计

不新造通用“所有主数据”表。本包覆盖 `users` 顾客资料与现场建档、`employee_profiles` 员工资料、`contractor_rates`、`stores`、`units` 入库/清洁、`price_policies`；每项成功业务写入与 `audit_log` 同事务，适用通知亦同事务。既有员工资料已在事务中，维持回归。

唯一约束核对：顾客/员工邮箱、库存编号、同承包人同日费率、价目版本与合同变更原有索引优先。门店名称目前只有代码级重复检查，迁移前需查历史重名数据；可安全加唯一索引时加，否则在本机结论中保留多进程竞态风险。新迁移不得更改历史订单、价格、合同哈希或已入库单件编号。

## 迁移与回退

实施前使用 011 的验证备份。新增表/列和索引采用可重复迁移，旧 `contract_adjustments.proposal_id` 为空；候选空库可建表，但 014 候选业务门槛继续拒绝交易。回退应用版本前保留新表与确认事实，不删除或伪装已确认变更；需明确旧应用不能安全办理新换装提交。测试仅在临时数据库运行破坏性场景。
