# 预约到期读取契约

## `GET /api/reservations` 与 `GET /api/reservations/{id}`

当持久行 `status=HOLD` 且服务器时间 `now >= hold_expires_at`，返回 `status: "EXPIRED"`、历史报价及 `workflow.currentKey: "EXPIRED"`。数据库原始行不变。其他状态按持久状态返回。顾客只能读取本人订单。

## 创建接口的安全重放

`POST /api/reservations` 与 `POST /api/operations/reservations` 的相同账号、渠道、键和负载重放返回 HTTP 200、原 ID/编号/报价、`replayed: true`、生效 `status: "EXPIRED"`。原键绝不创建第二单；新意向必须换键并重新接受当前库存及报价。

## 到期写操作

过期预约的合同开具/签署、演示付款与自行取消返回 HTTP 409，不产生新合同、流水、通知或审计。库存和员工未解决提醒将过期暂留排除。`EXPIRED` 只是读取模型，不能由客户端提交为可写数据库状态。
