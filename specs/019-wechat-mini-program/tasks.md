# Tasks: 网页与微信小程序共享租赁业务

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/mini-web-api.md](contracts/mini-web-api.md), [quickstart.md](quickstart.md)  
**Status**: 正式 AppID 已配置并在开发者工具本机项目详情核对；本机逻辑与隔离测试通过。真实微信身份交换、合法 HTTPS 域名、签发码及真机仍未完成，相关复合任务保留未验收。逐项证据见 [validation.md](validation.md)。
**Tests**: Constitution V requires meaningful automated and two-client end-to-end checks. Real WeChat scan/login requires platform credentials and publication eligibility; no mock may be marked as that evidence.

## Phase 1: Baseline and dependency gate

- [x] T001 Record 017/018 baseline, Node/browser totals and Web cart/API behavior in `specs/019-wechat-mini-program/validation.md`. Read-only snapshot of the live DEMO database records its logical digest and row counts without altering it. There is no persistent CANDIDATE database under `data/`; isolated old-CANDIDATE fixtures verify before/after logical equality instead of inventing a live digest.
- [x] T002 Inventory Web customer navigation, catalogue, date availability, shared cart, quote, reservation, order, pickup-code and damage paths in `public/app.js`, `src/server.mjs` and domain modules; map each to 019 FR/SC in validation.
- [x] T003 Check 018 SHOWCASE FR/SC and six-role browser completion. Isolated synthetic instances and local six-role business/recovery tests passed; keep public release and 019 cross-client acceptance separate. No public `Demo123!` fallback.
- [ ] T004 Recheck official WeChat AppID, login, QR, domain, filing and review rules against platform documentation at integration time; record exact platform dependencies and current availability. 2026-11-25 已按官方文档重新核对开发者工具项目配置、网络请求域名、预览/上传与小程序码的边界；正式 AppID 与用户提供的小程序备案号已入项目，HTTPS 域名登记、真实微信登录和审核仍待实际平台核验，故复合任务保留未完成。

---

## Phase 2: Schema, platform adapter and identity foundation

**Goal**: Introduce a safe mini identity and shared cart contract without changing existing Web account/order meaning.

### Tests first

- [x] T005 [P] Write idempotent migration and old-mode preservation tests for binding, mini-session and cart tables in `test/019-schema.test.mjs`. DEMO/CANDIDATE 隔离旧库重复初始化后逻辑摘要、模式、完整性与外键不变；固定首页扫码入口采用私有配置和签署凭据，无扫码状态表。
- [x] T006 [P] Write platform adapter tests for bad code, timeout, malformed response, retry bound, forbidden production mock and non-leakage in `test/019-wechat-platform.test.mjs`; private PNG integrity/path validation is covered by `test/019-mini-entry.test.mjs`. 失败请求恰好一次上游调用；正式平台响应仍须 T038 核验。
- [x] T007 [P] Write binding/session tests for one-use challenge, active `(AppID, OpenID)` and customer uniqueness, staff-role rejection, logout, disable and token replay in `test/019-mini-identity.test.mjs`; restore behavior in `test/019-recovery.test.mjs`. 解绑后新 OpenID 重新绑定且历史记录仍在。

### Implementation

- [x] T008 Add new tables/indexes and migration in `src/db.mjs` for `wechat_bindings`, `mini_login_challenges`, `mini_sessions`, `customer_carts` and `customer_cart_lines`; preserve old orders/provenance. Fixed `home` QR state is held by private startup configuration and signed receipt, not a database table.
- [x] T009 Implement production-only server-side `code2Session` adapter plus test-injected fake in `src/wechat-platform.mjs`; require private AppID/AppSecret, response validation, timeouts and no secret logging. This is adapter implementation, not real platform acceptance (T038).
- [x] T010 Implement `src/mini-identity.mjs`: verified platform code → pending challenge or known customer session; explicit customer account proof/binding, unique constraint handling, hashed bearer token, rate limits and independent revoke. Isolated fake-platform tests pass; real platform exchange is T038.
- [x] T011 Add a separate mini route/auth boundary in `src/server.mjs` / `src/mini-api.mjs` that preserves 017 proxy checks, Web Cookie/Origin behavior, candidate booking denial and demo loopback; reject mini tokens on Web routes.
- [x] T012 Run T005–T007 and existing candidate/demo auth/proxy tests; compare isolated old DEMO/CANDIDATE logical digests and row counts before/after migration. No live DB was altered; full-suite evidence is recorded in [validation.md](validation.md).

**Checkpoint**: A platform-authenticated customer identity is possible in isolated tests, with no business order action or public QR yet.

---

## Phase 3: User Story 1 — real Web scan entry (P1)

**Goal**: The website has a truthful Mini Program entry state; official scan works only after actual platform setup and approval.

### Tests first

- [ ] T013 [P] Write Web API tests for OFF/PAUSED/READY QR states, missing AppID, mismatched issuer, invalid image bytes, unsafe scene, private path leak and release switch in `test/019-mini-entry.test.mjs`. 本机状态、PNG 完整性、HMAC 人工批准、路径/场景及请求时到期守卫已测；真实微信签发者无法从本地 PNG 证明，仍待正式平台。
- [x] T014 [P] Add desktop and 390px browser assertions for the preparation card and a test-only verified QR fixture in `test/019-web-qr-browser.mjs`; do not call mock QR a real scan. 独立 SHOWCASE 合成夹具用本地 HMAC 签署 BSR 标志图片，明确**不是微信签发码**；OFF/PAUSED/READY 三态在 Chrome 桌面与 390px 通过，无全局横向溢出，小屏继续使用网页版按钮滚动后可操作。

### Implementation

- [ ] T015 Add guarded `/api/mini-entry` and image response in `src/mini-api.mjs`; serve only verified platform-issued bytes when both code status and release flag allow, never user-specific token/PII. 当前路由在 `src/server.mjs`，OFF/PAUSED 不供码，READY 需私有人工批准凭据；这不是平台签发证明，故真实来源门槛未关闭。
- [x] T016 Add Web mini-program card and scan instructions in `public/app.js` / styles, with visually distinct “筹备中” state and no fake QR or automatic cross-login. 本机代码与 OFF 状态接口测试已覆盖；正式扫码另见 T017/T039。
- [ ] T017 Add private operator procedure/tool to generate or import official homepage Mini Program code only after AppID and WeChat API access exist; record AppID/environment/hash without exposing platform secrets. 已新增本地人工完整性签署工具；正式码获取和真实 AppID 核验需在平台可用时继续。
- [x] T018 Validate T013/T014 and verify current local demo Web remains usable with mini entry off; record browser screenshots without secrets. `019-mini-entry.test.mjs` 的本机状态及请求时到期测试、`019-web-qr-browser.mjs` 的隔离浏览器三态通过；本机 DEMO 默认 OFF、图片路由 404，原网页入口可打开。合成截图仅保存于 Git 忽略的 `test-results/`，不含真实密钥；真实平台来源仍见 T017/T038/T039。

**Checkpoint**: Web entry is visually complete but true scan remains an external-platform acceptance task until real QR and release eligibility exist.

---

## Phase 4: User Story 2 — shared cart, reservation and fulfillment (P1)

**Goal**: Web and Mini clients operate the same customer cart, one order and one physical inventory commitment.

### Tests first

- [x] T019 [P] Test shared cart version conflicts, store/window changes and stale quote rejection in `test/019-shared-cart.test.mjs` / `test/019-cross-client-rental.test.mjs`; native guest-to-account merge and conflict handling are covered in `test/019-mini-pages.test.mjs`. Both clients use the same customer cart, while anonymous choices remain local until login.
- [x] T020 [P] Test cross-client catalogue/quote/reservation for accessories, rental-window validation, NOK, 8% deposit, consent snapshot, last-unit race, idempotency and cancellation in `test/019-cross-client-rental.test.mjs` plus existing rental-policy tests. Uses one isolated physical unit and does not alter live stock.
- [x] T021 [P] Test mini order reads for Web staff preparation/pickup/return, 24-hour damage feedback, original photo access, simulated refund/shortfall and own/other customer isolation in `test/019-order-sync.test.mjs`. Both clients read the same order ID and committed steps.

### Implementation

- [x] T022 Implement server-side `src/cart.mjs` with one active cart per customer, optimistic version and safe quote invalidation; migrate Web cart UI from local-only state to shared API without losing guest cart before login.
- [x] T023 Implement customer-scoped mini catalogue, cart, quote, reservation, list/detail and cancellation endpoints in `src/mini-api.mjs`, delegating business decisions to existing domain/fulfillment/damage modules.
- [x] T024 Ensure Web employee mutations publish/are readable as the same committed order stage, actor, role and time to mini customer endpoints; no second order or event store. Isolated clean-return and damaged-return cases both read back the same order through Mini's independent bearer session; T033 本机浏览器 + Mini HTTP 已通过，真实手机验收仍见 T038/T039。
- [x] T025 Run T019–T021 plus existing inventory, fulfillment, damage and policy tests. Isolated old DEMO/CANDIDATE migration checks preserve order/price/policy snapshots and runtime mode; full Node suite 220/220 passed without modifying live databases. No real money or platform acceptance is inferred.

**Checkpoint**: Shared server business contract passes in local isolation; native mini UI and real platform test still open.

---

## Phase 5: User Story 3 — native customer Mini Program and secure binding (P1)

**Goal**: Customer can browse, bind, book and track via a usable WeChat-native interface.

### Tests first

- [x] T026 [P] Add deterministic native-page/service tests for bootstrap, login state, challenge, cart conflict, consent, network error, token expiration and simulated money labels in `test/019-mini-pages.test.mjs`. 本机 wx 假平台与页面逻辑 6/6；不代表正式账号或真机。
- [x] T027 [P] Add two-client isolated end-to-end script with a mini HTTP client and real Web browser covering same customer ID, cart, order, employee handoff and damage case in `test/019-web-mini-e2e.mjs`. 独立 Mini Bearer 与真实 Chrome Web Cookie 共用合成 SHOWCASE，受损补差终态通过。

### Implementation

- [x] T028 Create `mini-program/` native project skeleton, environment example and customer-only navigation; public AppID may be in source, but no AppSecret, production URL, user credentials or token. 2026-11-25 正式 AppID 已配置，本机 Stable 模拟器显示目录 32 款规格、问题面板 0；真机另见 T038。
- [x] T029 Implement homepage, category/size/style filters, store and date-window selection, remaining inventory cards, and concise alpine visual style in native pages; data always from shared API.
- [x] T030 Implement shared cart, item quantities, stale-cart resolution, NOK quote breakdown, damage/late policy reading and explicit consent in Mini pages.
- [x] T031 Implement WeChat `wx.login` + explicit existing-customer binding, session storage/expiry/logout/clear-private-cache and helpful offline/network errors; staff role cannot bind. This is source and isolated-test completion, not real WeChat login acceptance.
- [x] T032 Implement own order list/detail, pickup code, current responsible stage/time, return deadline, damage result and simulated refund/shortfall labels; refresh on page re-entry and pull-to-refresh. Added scoped original-photo download and native preview entry; late download responses after account switch are rejected, their temporary file is removed, and the order page rechecks the active session before preview. Local API/page tests pass, but real-device photo preview remains part of T038.
- [x] T033 Run T026/T027, existing Web six-role browser and 390px inspection; compare same order and cart across clients with redacted screenshots. 本机 T026 6/6、T027 PASS、六角色浏览器 PASS；1440/390px 合成截图在忽略的 `test-results/`，不含真实顾客资料。真机与正式平台仍见 T038/T039。

**Checkpoint**: Native Mini source is locally buildable and end-to-end logic tested against a mock WeChat platform; public scan is not yet claimed.

---

## Phase 6: Recovery, documentation and real-platform acceptance

- [x] T034 [P] Test old DB migration, verified backup/restore, binding uniqueness after restore, revoked mini sessions/challenges and Web session compatibility in `test/019-recovery.test.mjs`. 独立 DEMO 旧结构补表两次不改历史订单/价目；合成 SHOWCASE 校验备份恢复撤销原 Mini/Web 会话及待绑定挑战，保留绑定唯一约束，恢复后 Web 与 Mini 可重新登录。专项 2/2 通过；不代表生产恢复演练。
- [x] T035 [P] Run package-equivalent full Node tests, 017 proxy browser, 018 six-role browser, Web QR browser and two-client end-to-end; record exact counts, failures, DB integrity and mode isolation in `validation.md`. 最近完整 Node 220/220，2026-11-25 小程序原生 15/15；017/018 浏览器、019 两客户端与独立网页扫码三态脚本此前通过。OFF/PAUSED 无图片，合成 READY 图仅用于布局和路径测试；正式码与真机留给 T038/T039。当前 PowerShell 无 `npm` 命令，使用 `node --test test/*.test.mjs` 执行同一 package 测试脚本。
- [x] T036 Update customer system use cases, use case specifications, modular class diagrams, sequence diagrams and requirement coverage for Mini/Web shared backend; preserve teacher PPT style and fix overlaps; do not add cloud preview logistics to core PDF. 4.12 六章 PDF、UC-16～21、U-MINI、C-MINI、S-UC19、ER-MINI-A/B、附录 J、requirement.txt 与系统规约/追溯矩阵已更新；91 页 A4 编译、图面目检通过，外部平台验收仍见 T038/T039。
- [x] T037 Update README/operator notes for `mini-program/`, external AppID/domain/filing/review gates, secret handling and QR OFF behavior. Inspect `public/` and intended GitHub package for any secret, DB, token or personal attachment. 本地 Git 暂存包已审阅，禁入文件路径与定向私钥/令牌扫描均为 0；4.12 PDF 已纳入 `docs/`，见 `docs/Git发布包审阅.md`。实际上传前仍须复核，尚未设置远端或开放权限。
- [ ] T038 **External platform gate**: With an actual user-owned AppID, lawful HTTPS domain and authorized test account, import project in official WeChat Developer Tools, verify build and authorized preview on a phone; record exact version and result. 2026-11-25 已在 Stable 2.02.2609250 项目详情核对正式 AppID，基础库 3.17.6 模拟器显示目录、购物车、订单/详情与个人页，所查页面编译错误及问题面板均为 0；没有执行微信“预览”上传、真机或 HTTPS 请求域名验收，故保留未完成。
- [ ] T039 **External scan gate**: After official platform-generated QR, applicable filing/review and user's release approval, scan site code in WeChat on real phones, check entry/login/binding/order sync and invalid scene; never mark local mock as this result.
- [x] T040 Map each FR-001～015 and SC-001～007 to passing test/platform evidence or a named unresolved dependency in `validation.md`; missing platform and end-to-end gates remain explicitly open.

## Dependencies and parallel work

`T001–T004 → T005–T012 → (T013–T018 US1) ∥ (T019–T025 US2) → T026–T033 US3 → T034–T040`.

The 018 SHOWCASE implementation must pass before full cross-client order acceptance. T013/T014 can be tested in OFF state; T017, T038 and T039 still need official platform access beyond the configured AppID. T005/T006/T007 and T013/T019/T020/T021 can be written in parallel against separate files. DB migrations and `src/server.mjs` edits are sequential to avoid conflicting security boundaries. Website/GitHub publication is outside these tasks until the user's later decision.
