# Validation Quickstart

在 `bsr-app/` 运行：

```powershell
node --test test/idempotent-reservation.test.mjs
node --test test/*.test.mjs
node test/preview-smoke.mjs
```

手工路径：顾客把装备加入购物车、阅读损坏规则并提交。创建中重复点击应保持一个提交；若网络响应丢失，原页面可重试并进入同一订单。员工现场开单同理。API 使用同一 `Idempotency-Key` 及相同正文应返回原 ID；同键不同内容返回 409。登录身份不允许靠键看到他人订单。

迁移核对：测试副本执行两次升级，比较原预约数、NOK 金额、合同哈希和外键完整性；保留旧订单无映射的事实。

**2026-11-02 本地结果**：实施前备份 `data/backups/bsr-before-009-20261102.sqlite` 的完整性为 `ok`；实施后运行库 37 张表、`integrity_check=ok`，原有 4 笔订单的编号、NOK 金额、状态和报价 JSON 与备份一致。Node 全套 45/45 通过；Chrome 隔离库冒烟通过线上和现场丢失响应后的刷新找回。`/api/health` 与登录页均返回 HTTP 200。生产多实例、真实资金和合格签署尚未验收。

