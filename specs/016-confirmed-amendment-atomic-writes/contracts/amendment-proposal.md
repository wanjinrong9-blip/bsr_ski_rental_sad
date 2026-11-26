# 016 接口契约：换装草案、本人确认与提交

均沿用既有登录会话、对象授权及 `no-store` 私有响应。候选模式保持交易写入关闭。`id` 为整数；NOK 金额为整数，正数表示应补收、负数表示演示应退。错误体仍为 `{ "error": "可理解的原因" }`，未经授权不得泄露其他顾客订单是否存在。

## 保留只读预览

`POST /api/reservations/:id/amendments/quote`，仅本店员工/经理，沿用既有输入 `{removeUnitIds,addItems,effectiveAt?}` 与结果 `{reservationId,baseVersion,effectiveAt,removed,added,rentDeltaNok,depositDeltaNok,netNok,currency:'NOK',quoteHash,rule}`。不写草案、顾客确认、合同或库存。预览仍为 5 分钟内可重算的演示 NOK 价目。

## 员工提出草案

`POST /api/reservations/:id/amendments/proposals`，仅本店员工/经理，必须携带 16–128 字符 `Idempotency-Key`。请求：

```json
{"removeUnitIds":[12],"addItems":[{"variantId":3,"qty":1}],"effectiveAt":"2027-01-02T10:00:00.000Z","returnStoreId":1}
```

服务端使用当前事实重新预览，不接受客户端提交的价格、摘要或顾客确认状态。成功 `201`，同一员工同键同内容重放 `200`，响应：

```json
{"id":71,"status":"PENDING","quote":{"reservationId":8,"baseVersion":1,"effectiveAt":"2027-01-02T10:00:00.000Z","removed":[],"added":[],"rentDeltaNok":120,"depositDeltaNok":40,"netNok":160,"currency":"NOK","quoteHash":"sha256...","rule":"演示规则说明"},"expiresAt":"2027-01-02T10:05:00.000Z","confirmedAt":null}
```

上例数值仅示意结构，不是 BSR 价目。草案创建与通知同事务。相同标识不同内容 `409`；已确认且未过期的另一个草案不能被员工覆盖 `409`；尚未确认的旧草案可在同一事务标为 `SUPERSEDED`。过期、非 ACTIVE、跨店、无库存、旧版本按现有预览规则拒绝，不建立草案。

## 查询草案

`GET /api/reservations/:id/amendments/proposals` 返回 `{items:[proposal,...]}`，按时间逆序，仅本人顾客或本店员工/经理；`GET /api/reservations/:id/amendments/proposals/:proposalId` 返回上述单对象。顾客视图仅含公开的单件、NOK 明细、状态、截止、发起岗位/姓名；不含内部备注、其他顾客资料或员工私有账号字段。到期按服务器时钟投影为 `EXPIRED`，GET 不写数据库。跨对象访问 `404`，未登录 `401`，非相关角色 `403`。

## 顾客本人确认或拒绝

`POST /api/reservations/:id/amendments/proposals/:proposalId/confirm`，仅该订单顾客本人。请求：

```json
{"accepted":true,"baseVersion":1,"quoteHash":"sha256..."}
```

`accepted` 必须是布尔值；顾客须提交当前显示的版本及摘要。未过期且仍 `PENDING`、订单仍 ACTIVE、合同版本相符时，写 `confirmed_by/at` 或 `rejected_by/at`、审计事件并回传更新的 proposal，状态 `CONFIRMED`/`REJECTED`。相同动作重复 `200` 返回原事实，不写第二次事件；反向动作、旧摘要/版本、被取代、过期或已消费返回 `409` 且零业务副作用。员工、经理、其他顾客不能代确认；需从会话身份判定，不接受 body 中的用户 ID。

## 员工最终提交

`POST /api/reservations/:id/amendments`，仅本店员工/经理。请求至少含 `proposalId`、原有唯一演示收退凭证 `reference`、现场检查与纸质见证字段 `goodReturnConfirmed`、`newItemsChecked`、`paperSigned`、`customerName`、`note`。服务端从草案冻结的 `input_json` 重算差价及库存；若兼容旧表单传入单件/摘要/版本字段，须与草案完全一致，不得改写已确认内容。只有 `CONFIRMED` 且未过期、本人确认账号等于订单顾客、原合同版本与重算摘要不变、现场检查有效才执行。执行、草案 `CONSUMED`、合同/单件/金额/审计/通知同事务提交。原 `reference` 同内容重试返回已存在 `id` 且 `duplicate:true`；不同内容复用凭证 `409`。没有 `proposalId` 的新提交 `409` 或 `422`，不能以员工的 `paperSigned` 绕过本人确认。

## 状态与失败矩阵

| 条件 | 结果 | 不得改变 |
| --- | --- | --- |
| 顾客未确认或拒绝 | `409`，提示先由本人确认或重新提出 | 合同、单件、金额、通知 |
| 过期、合同变化、单件/价目变化 | `409`，提示重新预览并再确认 | 原确认事实、合同、单件、金额 |
| 其他顾客/异店/技师/经营汇总猜测 ID | `404` 或 `403`，最小信息 | 全部业务状态 |
| 同键同内容重试 | 返回原草案/确认/变更 | 不新增第二份结果 |
| 同键异内容或过期版本 | `409` | 现有有效草案及业务状态 |
| 审计或通知写入失败 | 同一事务回滚 | 草案消费、合同、单件、金额及审计 |

历史 `contract_adjustments` 无 `proposal_id` 时仅显示“历史人工见证”；不补造在线确认。所有“补收”“退回”均须标注为本地演示，不宣称银行流水或合格电子签章。
