# Interface contract: Web ↔ WeChat Mini Program ↔ shared rental service

**Status**: 目标接口契约已有本机部分实现。`GET /api/mini-entry`、`GET /api/mini-entry/code`、Web 共享购物车及独立 `/api/mini/*` 顾客身份/业务路由已在隔离合成实例验证；正式扫码和真机仍未验收。实际证据见 [validation.md](../validation.md)。所有 JSON 使用 UTF-8 和稳定公开错误码，业务规则调用既有服务端领域函数。

## 1. Trust boundaries

```text
Web browser -- HTTPS + HttpOnly Secure Cookie + exact Origin --> trusted proxy --> Node
WeChat Mini Program -- HTTPS + dedicated Bearer token ----------> trusted proxy --> Node
Node -- server-side HTTPS + private AppID/AppSecret -------------> WeChat platform
Node -- one private single-writer SQLite ------------------------> stock/orders/policies
```

- `DEMO` keeps local loopback only. `CANDIDATE` keeps booking denied. New mini routes are enabled only for an explicitly configured secure SHOWCASE until a separately approved production mode exists.
- Proxy still validates Host, transport and client address before both Web and Mini routes. Mini routes do not accept a fabricated Web `Origin` as authentication. A Web Cookie does not authenticate Mini routes; a Mini Bearer token does not authenticate Web routes.
- Public catalog reads are anonymous only where the existing mode allows them. Order, cart, binding and account routes require an active account/session and per-object authorization.

## 2. Platform adapter (server only)

| Operation | Input | Success | Failure |
| --- | --- | --- | --- |
| `exchangeCode(code)` | One freshly obtained `wx.login` code and configured AppID/AppSecret | Validated `openid` and optionally `unionid` in server memory; no `session_key` returned to client | Timeout, non-2xx, platform error, missing/malformed OpenID, AppID/config mismatch → stable error; no account/session created. |
| `obtainMiniCode(page, scene)` | Allowlisted public page and non-sensitive scene | Platform-issued PNG/JPEG bytes plus hash, AppID/environment and verification time in private setup flow | Platform error/invalid image → existing website QR state unchanged. |

Production adapter may call only official HTTPS API endpoints with bounded timeout and response-size guard. Test adapter is injectable **only** under test configuration and cannot be selected by a live deployment variable. Platform access tokens and secrets never enter `public/`, logs, JSON responses or QR parameters.

## 3. Anonymous entry and configuration

| Endpoint | Auth | Success | Failure / rule |
| --- | --- | --- | --- |
| `GET /api/mini-entry` | None | 当前返回 `{status:'off'|'ready'|'paused',qrUrl:string|null}`；仅本地 READY 且发布开关启用时有图片 URL。 | HMAC 凭据只代表人工批准/本地完整性；不能证明微信签发。不得暴露私有路径、密钥或令牌。 |
| `GET /api/mini-entry/code` | 仅本地 READY 时可取 | 当前返回经过本地批准且摘要未变化的私有 PNG，`Content-Type: image/png` 与 `nosniff`；这不是微信签发证明。 | OFF/PAUSED、来源凭据无效或配置不匹配时不返回图片；不得合成普通网址二维码充数。真实平台签发与手机扫码仍待验收。 |
| `GET /api/mini/bootstrap` | None | Mode/capabilities, `synthetic`, service version, customer-only role scope, NOK/time rules, public category data | Does not return user identity, demo credentials or private data. |

The Web card may include a visible “微信扫一扫进入小程序” instruction only when the official code is verified. Before platform readiness it says “微信小程序筹备中” and keeps Web navigation available. Scan destination is the mini home page. Scene values never contain email, phone, order ID, session token or privileged role.

## 4. WeChat login, binding and session

| Endpoint | Request | Success | Failure / invariant |
| --- | --- | --- | --- |
| `POST /api/mini/auth/wechat` | `{code}` from `wx.login` | Existing active binding: `{status:'authenticated',sessionToken,user:{id,role:'customer'}}`; no binding: `{status:'needs_binding',challenge,expiresAt}` | Replayed/invalid code, platform failure or disabled account: 4xx/503, no private data. Before any platform exchange, the trusted client IP has a private HMAC bucket limited to 30 attempts per 10 minutes; the next request returns 429 with Retry-After and never calls code2Session. The upstream adapter makes at most one call per code request. Never return OpenID, `session_key` or AppSecret. |
| `POST /api/mini/auth/bind` | `{challenge,email,password,explicitConsent:true}` | Atomically verify active `customer`, consume challenge, create unique binding, return mini session and safe user | Employee role, weak/incorrect proof, duplicate/conflicting binding, expired/used challenge: 4xx/409, no binding. Rate limit by verified client IP and account. |
| `GET /api/mini/me` | `Authorization: Bearer <mini-token>` | Safe current customer profile and binding status | 401 for expired/revoked/stale epoch; 403 for non-customer. |
| `POST /api/mini/auth/logout` | Bearer token | Revokes **this** mini session; repeated logout idempotent | No active token → safe no-op/401 as documented implementation choice, no other user's session touched. |
| `POST /api/mini/auth/unbind` | Bearer + fresh account proof or equivalent step-up | Revokes active binding and all its mini sessions; audited | Wrong proof/other account: 403, no change. |

Headers and bodies containing raw temporary code, password, challenge or token are never logged. Mini storage may hold only the issued mini token and non-sensitive UI preferences; on logout, invalid session or account disable, private cached order/profile content is cleared. Web and Mini logout are independently scoped; account disable and restore invalidate both.

## 5. Shared customer business endpoints

The following paths may be implemented as customer-scoped wrappers or an authenticated shared API version; they must delegate to the **same** catalog, quote, stock, reservation, fulfillment and damage domain functions as Web. The output shapes below are required even if the final path names differ in implementation.

| Capability / planned path | Input / precondition | Response and business rule |
| --- | --- | --- |
| `GET /api/mini/catalog?storeId&pickupDate&returnDate&category&size&style` | Valid store and Europe/Oslo dates; anonymous read if mode allows | Items with `variantId`, classification, size/style, `availableCount`, NOK rent/reference value/deposit indication, policy version and query time. Service calculates inventory for selected 09:00–16:00 window. |
| `GET /api/mini/cart` | Active customer mini session | One server cart with `version`, store/window, lines and current quote status; no other user's cart. |
| `PUT /api/mini/cart` | Bearer; `{expectedVersion,storeId,pickupDate,returnDate,lines}`; idempotency key | Updated cart and incremented version. `409 CART_STALE` returns latest cart; no lost Web edits. Cart does not reserve units. |
| `POST /api/mini/quote` | Bearer; cart version | Server quote with NOK rent, each item's reference value × 8% deposit, total, expected return, late/damage terms, `policyVersion`, `quoteExpiresAt`, `simulation` flag. |
| `POST /api/mini/reservations` | Bearer; cart version, fresh quote ID/version, policy consent version/time, idempotency key | Exactly one reservation with immutable amounts and policy snapshot, pickup code, owner and status. Recheck physical units and conflict; stale quote/stock/policy produce 409/422 without order. |
| `GET /api/mini/reservations` and `GET /api/mini/reservations/{id}` | Bearer | Only own orders; stage, actor/role/time, pickup code, expected return, line amounts, damage/settlement simulation fields. A different customer's ID yields 404/403 without detail leak. |
| `GET /api/mini/damage-photos/{id}` | Bearer; own order | Return the original validated JPEG/PNG/WebP bytes with their stored MIME type and `Cache-Control: private, no-store`. An unrelated customer's photo yields 404 and an unauthenticated request 401; no photo bytes or private storage path enter the order JSON or public directory. |
| `POST /api/mini/reservations/{id}/cancel` | Bearer; own eligible order; idempotency key | Uses existing cancellation policy/state; re-releases allocation exactly once. |

Mini clients may refresh on page display and on explicit pull-to-refresh, with limited foreground polling for order status. They must not assume stale cached availability is bookable. Staff Web SSE/event handling continues; both ultimately read the same committed database state.

## 6. Error and idempotency semantics

Stable `code` values include `MINI_NOT_READY`, `WECHAT_UNAVAILABLE`, `CODE_INVALID`, `BINDING_REQUIRED`, `BINDING_CONFLICT`, `SESSION_EXPIRED`, `ACCOUNT_DISABLED`, `CART_STALE`, `QUOTE_EXPIRED`, `STOCK_CHANGED`, `CONSENT_REQUIRED`, `FORBIDDEN` and `RATE_LIMITED`. Public error text may explain recovery without echoing secrets, raw platform response, private path or another user's object.

State-changing requests use a bounded, customer-scoped idempotency key and/or existing domain version check. Repeating a successful reservation returns the same ID; a different payload with the same key is rejected. Failed binding or booking leaves business row counts and versions unchanged. Mode-switch, restore and account disable revoke sessions in accordance with 018.

## 7. Platform and release gate

No true QR/login success is claimed from a stub. The user-supplied public AppID `wx51ce51fc873371a6` is configured, and the user reports Mini Program filing `湘ICP备2026056763号-1X`; neither constitutes a platform login or release test. Private AppSecret, registered HTTPS request domain (with `bsrski.cn` ICP still under review), official platform code, applicable review/approved version and phone/WeChat test remain needed for public scan acceptance. Until those are verified, Web displays preparation state and Mini capability remains disabled to public users. Website/GitHub publishing follows the user's later authorization.
