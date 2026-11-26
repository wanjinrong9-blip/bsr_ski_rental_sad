# Data Model: 线上合同先签后付款

## 已有实体与本次语义

| 实体 | 关键字段 | 本次约束 |
| --- | --- | --- |
| `reservations` | `id`, `user_id`, `status`, `hold_expires_at`, `contract_version`, `assigned_staff_id`, `created_by`, `late_grace_minutes` | `HOLD` 且未过期才可签付；线上自助的 `created_by` 保持空，避免伪计员工开单。`assigned_staff_id` 表示备货/门店经办责任。 |
| `contracts` | `id`, `reservation_id`, `version`, `created_by`, `snapshot_json`, `snapshot_hash`, `signed_by`, `signed_at`, `signature_method` | `created_by` 是实际发起动作的人；线上可为顾客，现场为员工。仅 `version=reservation.contract_version` 且 `signed_at` 非空授权付款；历史版本不可覆盖。 |
| 合同快照 | `customer`, `employee`, `lines`, `rentNok`, `depositNok`, `latePolicy`, `terms` | 新版加 `channel`，明确自助/现场；`employee` 是门店经办责任人，不自动代表实际创建者。旧快照缺 `channel` 按旧义展示，不回写。 |
| `payments` | `reservation_id`, `type`, `amount_nok`, `provider_ref`, `idempotency_key` | 一单初始租金与押金各至多一笔；失败事务不留流水。继续标为演示结果。 |
| `preparations` | `reservation_id`, `status`, `assigned_to` | 仅付款确认后创建；客户可见准备进度，责任人优先沿用订单分配。 |
| `audit_log` | `actor_id`, `action`, `target_type`, `target_id`, `detail_json` | 记录真实发起人、合同版本、签署摘要及演示付款；不存明文会话凭证。 |

## 状态与不变量

```text
新订单：HOLD（无合同）→ HOLD（有未签当前合同）→ HOLD（已签当前合同）
        → CONFIRMED（演示付款一组，生成准备任务）→ READY → ACTIVE ...
取消 / 过期：HOLD → CANCELLED 或过期拒绝后重新预约；不生成付款记录。
历史订单：保留原状态和事件顺序；已付但未签的旧单仍须签署方能交付。
```

- 合同快照以订单冻结的 NOK 价目、规则版本和顾客资料生成。新的自助来源写入新合同，不能修改历史 JSON/hash。
- 不新增或重建现有表，故无需数据库迁移；上线前仍备份运行数据库，验证旧合同及已付款流水未变。
- 同一订单的合同版本与付款写入在服务端事务中校验。重复或并发付款不能生成第二组流水。
- `created_by` 的两处含义不同：`contracts.created_by` 是真实发起人；`reservations.created_by` 是员工实际开单归属。顾客自助合同不得把 `reservations.created_by` 写成员工。
