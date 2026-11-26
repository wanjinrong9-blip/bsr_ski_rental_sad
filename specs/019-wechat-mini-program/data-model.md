# Data Model: 双客户端身份与共享购物车

**Status**: 绑定、挑战、已用临时码、独立会话、报价与共享购物车表已在本机新库/旧库结构迁移中实现并经隔离测试。固定首页扫码入口使用私有配置和签署凭据，不需要数据库扫码状态表；用户提供的正式 AppID 已配置并在开发者工具项目详情核对，真实微信签发和真机仍待外部验收。

## Existing aggregates remain authoritative

`users`, `sessions`, `stores`, `variants`, `units`, `price_policies`, `reservations`, `reservation_items`, `payments`, `damage_cases`, `stock_events` and related audit structures retain their existing business meaning. New mini-program tables never replace order, physical stock or price snapshots. Customer requests from both clients must reach the same domain service and the same single-writer SQLite database.

| Entity | 019 rule |
| --- | --- |
| `users` | Only `role='customer'` is bindable to a WeChat identity. Existing `id` is the canonical cross-client customer ID. Deactivation/auth epoch applies to both clients. |
| `variants` / `units` | One catalogue and one set of stable physical inventory numbers. App does not cache a saleable count as authority. |
| `reservations` / items | One order ID and immutable NOK/policy/consent snapshots regardless of client of creation. Optional `created_channel='web'|'wechat-mini'` is audit metadata, not a separate order type. |
| `payments` / settlement | Existing synthetic semantics in SHOWCASE. Channel metadata cannot make simulated funds appear real. |
| `audit_log` | Include channel, actor ID, event, result and timestamp without raw OpenID, temporary code, token or password. |

## New identity structures

### `wechat_bindings`

| Field | Constraint and meaning |
| --- | --- |
| `id` | Stable surrogate primary key. |
| `app_id` | Exact configured public AppID; environment-bound. Unique with `openid_digest` and with `user_id`. |
| `openid_digest` | Keyed digest of platform OpenID, not raw value; unique per AppID. Key material private and versioned for rotation. |
| `user_id` | Foreign key to a customer account; `role='customer'` checked in service transaction. |
| `bound_at`, `unbound_at`, `version` | Binding lifecycle and optimistic conflict protection. At most one active binding per `(app_id, user_id)` and `(app_id, openid_digest)`. |
| `proof_method`, `proof_at` | Account control verification type/time without the password or code. |

State: `UNBOUND → PENDING_ACCOUNT_PROOF → BOUND → REVOKED`. Rebinding requires fresh platform code, fresh account proof and atomic revocation of the prior active binding/session. A database uniqueness violation maps to a safe conflict response, never a silent merge.

### `mini_login_challenges`

| Field | Constraint and meaning |
| --- | --- |
| `challenge_hash` | Unique hash of random pending-binding token; raw token only returned once to the same mini-program client. |
| `app_id`, `openid_digest` | Identity obtained from a verified one-use WeChat code; no `session_key` stored. |
| `created_at`, `expires_at`, `consumed_at` | Short TTL, single use, cleanup after expiry. |
| `attempt_count` | Bounded account proof attempts; unsuccessful proof cannot keep a challenge active indefinitely. |

The challenge is not an authenticated business session and cannot access orders. It is consumed in the same transaction as successful binding.

### `mini_code_uses`

已实施的 `code_digest` 主键记录 AppID、使用和过期时刻，阻止同一微信临时 `code` 在本站重放；仅保存私有 HMAC 摘要，不存原码。已用码不能作为绑定挑战或会话再次发行的依据。

### `mini_sessions`

| Field | Constraint and meaning |
| --- | --- |
| `token_hash` | Unique cryptographic hash; no raw bearer token is stored in DB, logs, QR or URL. |
| `user_id`, `binding_id`, `app_id` | Foreign keys/validated identity; must still reference active binding and active customer on each private request. |
| `issued_at`, `expires_at`, `revoked_at`, `last_seen_at` | Session lifecycle, bounded expiry and revocation. |
| `auth_epoch` | Snapshot of account epoch; password change, disable, binding revocation and relevant restore invalidate prior token. |

Web browser `sessions` remain separate. The service never accepts a mini bearer token as a web Cookie or a web session as mini authority.

## Shared cart

### `customer_carts`

一个顾客一份购物车，已实施 `customer_id` 唯一、`store_id`、`pickup_at`、`return_at`、`version`、`updated_at`；当前表**没有**购物车 `status` 列。日期按 Europe/Oslo 解释。购物车是提案，不占用实物；门店或租期变化使版本递增，旧小程序报价不能用于提交。

### `customer_cart_lines`

已实施复合主键 `(cart_id, variant_id)`、每行数量 1～5 与 `updated_at`；当前没有行项目 `created_at`。购物车引用规格，不直接占用实物；最终分配只在预约事务中发生，购物车不保存历史价格。服务器核算当前价目和可订量。

### `mini_quotes`

已实施 `quote_id` 主键、顾客 ID、购物车版本、报价指纹、下单输入快照、创建与过期时刻。小程序预约须提交同一顾客的报价 ID 和当前购物车版本；服务端再校验时效、价目/库存及原有预约幂等键。该表不替代订单的 NOK 金额与政策快照。

Both clients use `If-Match`/cart version or an equivalent explicit version in mutation requests. Stale updates return a conflict with latest cart, never silently overwrite another client's edits. Anonymous temporary carts may remain client-side and contain no private information; login merge is explicit and subject to capacity/current policy recheck.

## Web scan entry

**固定首页入口的权威状态**：`src/mini-entry.mjs` 读取启动配置提供 OFF/PAUSED/READY；READY 需同一 AppID、私有 PNG 的结构/CRC 与摘要、固定公开首页 `home` 场景、期限、HMAC 人工批准凭据及发布开关。PNG 和签署凭据位于项目目录外，不含个人参数。服务端每次返回公开状态或图片时重新检查期限，到期立即按 PAUSED 处理并停止供图；旧的裸 PNG 配置不能发布。固定场景没有需要持久化的用户映射，故不建 `mini_entry_config` 表。HMAC 只证明本站操作批准和文件完整性，**不能证明图片由微信签发**；正式 AppID 已知，但真实微信码、平台发行资格和真机扫码仍待外部验收。

**未来扩展边界**：如果增加动态商品或活动场景，再设计 `mini_scene_codes`，将不透明短码映射到允许的公开路由、状态和有效期；不得映射私人订单或授予权限。当前仅接受固定 `home` 场景，所有其他 scene 均拒绝；未来引入动态 scene 时须先落实映射校验和测试。

## Migration, indexes and recovery

1. Capture existing schema/row counts and a verified backup before migration. Add new tables/indexes without rewriting existing order rows or `runtime_installation` values.
2. Unique indexes protect active binding pairs; foreign keys protect customer and binding references. Application transaction checks customer role, active status and account epoch.
3. Repeated migration is idempotent. Existing DEMO and CANDIDATE mode behavior remains unchanged; mini-login/QR is disabled outside an explicitly enabled secure SHOWCASE until a later formal release gate.
4. Backups include new private identity/cart tables with the same mode/instance provenance checks as 018. Restored sessions and pending challenges are revoked; QR and AppSecret remain separately managed, never embedded in database backup for a public viewer.
5. Test `PRAGMA integrity_check`, foreign keys, duplicate binding races, stale cart version, old order snapshot preservation and mode/source mismatches. Rollback never deletes an already booked order.
