# Data Model: ReservationRequest

`reservation_requests` 是创建预约的写入去重映射，不是支付幂等表。

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| `actor_id` | INTEGER NOT NULL FK → users.id | 实际提交人，顾客或现场员工 |
| `channel` | TEXT NOT NULL CHECK (`ONLINE`,`COUNTER`) | 创建渠道 |
| `request_key` | TEXT NOT NULL | 客户端一次意向的随机标识 |
| `payload_hash` | TEXT NOT NULL | 规范化请求体的 SHA-256 |
| `reservation_id` | INTEGER NOT NULL UNIQUE FK → reservations.id | 首次成功创建的订单 |
| `created_at` | TEXT NOT NULL | 首次创建时刻 |

主键为 `(actor_id, channel, request_key)`；外键和唯一约束让一个标识只对应一单，一单只对应一次创建意向。历史订单没有此映射，不回填。重放只读映射和订单现状；新的合法意向使用新键。由于必须先创建预约主键，首次请求在同一事务中完成预约及映射插入。

