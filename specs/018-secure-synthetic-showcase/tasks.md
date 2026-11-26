# Tasks: 安全合成数据全功能预览

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/showcase-contracts.md](contracts/showcase-contracts.md), [quickstart.md](quickstart.md)
**Status**: Phase 1–5 (T001–T038) passed isolated local verification. Phase 6 has a full 191/191 Node regression and all four local browser suites, including SHOWCASE desktop/390px booking, preparation and handoff. T041 release-package audit is now complete after the authorized GitHub delivery; real cloud/platform acceptance remains separate in 019 and deployment records.
**Tests**: Required by FR-014 and Constitution V; write failing tests before related implementation. All fixture paths must be temporary and private.

## Phase 1: Setup

**Goal**: Freeze safe baselines and identify mode-dependent code paths before implementing 018.

- [x] T001 Record current demo, candidate, 017 trusted-proxy test totals and untampered source DB digests in `specs/018-secure-synthetic-showcase/validation.md` using private read-only inspection.
- [x] T002 Inventory every `isCandidate`, `runMode==='candidate'`, `seed(db)` and `demo:false` branch in `src/server.mjs`, `src/db.mjs`, `src/catalog-upgrade.mjs`, `src/runtime-config.mjs`, `src/runtime-provenance.mjs`, `src/identity.mjs`, `public/app.js`, `public/fulfillment.js` and `public/damage.js`; record intended security-vs-business split in `specs/018-secure-synthetic-showcase/validation.md`.
- [x] T003 [P] Build isolated temporary SHOWCASE fixture helpers with no real/customer/demo data in `test/018-showcase-fixtures.mjs`; assert `@bsr.demo`, `Demo123!` and `BR-DEMO` are absent.

---

## Phase 2: Foundational security and schema

**Goal**: Introduce an exact third mode without broadening demo or candidate behavior. These tasks block all user stories.

- [x] T004 [P] Write failing startup matrix tests for missing/invalid mode, wrong DB provenance, weak/invalid proxy configuration, public/backup paths and zero-side-effect rejection in `test/018-showcase-startup.test.mjs`.
- [x] T005 [P] Write failing legacy regression tests for existing DEMO and CANDIDATE sources, CHECK constraints, candidate booking denial, demo loopback, and repeated migrations in `test/018-showcase-compatibility.test.mjs`.
- [x] T006 Extend read-only `BSR_RUN_MODE=showcase` configuration validation while keeping omitted mode `demo`, 017 trusted proxy and direct TLS requirements in `src/runtime-config.mjs`; require explicit private DB/backup paths and exact HTTPS origin.
- [x] T007 Extend common schema for **new** DBs with `SHOWCASE` provenance and dataset marker; keep existing DBs in original mode and avoid a CHECK table rebuild in `src/db.mjs`.
- [x] T008 Separate structural catalog migration from demo-only master-data insertion in `src/catalog-upgrade.mjs` and `src/db.mjs`; SHOWCASE must never call `seed(db)` or receive demo `coreValues`, `BSR-...` units, accounts or orders.
- [x] T009 Extend non-mutating source preflight for `SHOWCASE` with exact run-mode, READY, schema/dataset/admin/forbidden-demo checks in `src/runtime-provenance.mjs`; inspect an in-memory snapshot before opening any existing DB.
- [x] T010 Make managed authentication and 017 trusted proxy boundary apply to both CANDIDATE and SHOWCASE while retaining role/object checks in `src/identity.mjs`, `src/proxy-boundary.mjs` and `src/server.mjs`; candidate transaction denial remains independent.
- [x] T011 Run the T004/T005 mode and migration matrix, then record failing or passing cases with DB digest comparisons in `specs/018-secure-synthetic-showcase/validation.md`.

**Checkpoint (historical Phase 2)**: SHOWCASE had its own safe empty-source identity. Phase 3 added controlled initialization and Phase 4 subsequently enabled simulated business activity.

---

## Phase 3: User Story 1 — controlled synthetic installation (P1) 🎯 MVP

**Goal**: A new private instance can be initialized with artificial master data and six individual managed accounts.

**Independent Test**: From an empty directory, initialize once, provision five roles, log in as each; wrong-source/known-demo credential attempts fail with unchanged files.

### Tests first

- [x] T012 [P] [US1] Write failing atomic/repeated/parallel initialization tests, including incomplete dataset and weak admin credentials, in `test/018-showcase-init.test.mjs`.
- [x] T013 [P] [US1] Write failing six-role provisioning, first-login change, disable/logout and public-demo-credential rejection tests in `test/018-showcase-identity.test.mjs`.

### Implementation

- [x] T014 [US1] Define `showcase_dataset` singleton with `synthetic=1`, unique `instance_id` matching installation, positive dataset version and creation time in `src/db.mjs`; keep schema migration idempotent.
- [x] T015 [US1] Implement one-transaction, lock-protected SHOWCASE initialization with random instance ID, initial admin, marker and rollback-on-failure in `src/runtime-provenance.mjs`; never silently convert an existing DB.
- [x] T016 [US1] Add curated fictional two-store catalog, categories (including goggles and knee pads), at least 20 uniquely numbered units, `retail_nok >= 0` and versioned example NOK policies in `src/showcase-data.mjs`; compute each item deposit as `Math.round(retail_nok * 0.08)` and exclude demo identities/orders.
- [x] T017 [US1] Add TTY-only `preflight|init` command with hidden strong password input and non-secret output in `tools/showcase-setup.mjs`; do not share candidate setup mode or accept CLI/password environment argument.
- [x] T018 [US1] Reuse managed admin account creation and first-login password change for five additional unique roles, with fictional employee profile and starter shift after staff account creation, in `src/server.mjs` and `src/identity.mjs`; reject `@bsr.demo`, known demo/weak passwords and staff role self-registration.
- [x] T019 [US1] Return a SHOWCASE-only bootstrap capability and synthetic-data warning with no `demoLogin` credentials in `src/server.mjs`; render managed login, logout and first-login UX in `public/app.js`.
- [x] T020 [US1] Run T012/T013 plus full candidate login/permission tests; record six individual role access, source marker and zero demo data in `specs/018-secure-synthetic-showcase/validation.md`.

**Checkpoint (historical Phase 3)**: The MVP proved isolated six-role managed login; Phase 4 subsequently enabled the simulated transaction flow.

---

## Phase 4: User Story 2 — full simulated rental lifecycle (P1)

**Goal**: All six roles operate the same synthetic order state while funds, signature, prices and photos remain unmistakably simulated.

**Independent Test**: A normal and a damage/shortfall order reach terminal states across six accounts, with coherent stock, assigned worker, NOK snapshots and restricted object access.

### Tests first

- [x] T021 [P] [US2] Write failing quote/cart/availability/reservation tests for date interval, server recheck, last-unit race, cancellation, repeat submission, 8% retail-reference deposit and policy snapshot in `test/018-showcase-rental.test.mjs`.
- [x] T022 [P] [US2] Write failing staff/technician/manager/owner workflow tests for handoff, return, 24h assessment, severity, synthetic private photo, refund, shortfall and alerts in `test/018-showcase-operations.test.mjs`.
- [x] T023 [P] [US2] Write failing six-role and own/other-object permission matrix, proxy Origin/Host spoofing and stopped-session tests in `test/018-showcase-access.test.mjs`.
- [x] T024 [P] [US2] Write isolated trusted-proxy desktop and 390px browser scenario for six accounts, two order outcomes, simulated labels and synchronized stage/owner in `test/018-showcase-browser.mjs`.

### Implementation

- [x] T025 [US2] Split security-managed checks from `transactionsBlocked=candidate` in `src/server.mjs`; audit each existing `isCandidate` guard so SHOWCASE can use catalog, quote, cart, reservation, policy, fulfillment, damage, shifts, attendance, alerts, account and audit routes without weakening CANDIDATE.
- [x] T026 [US2] Ensure quote, reservation and fulfillment use the existing service-side single-unit, interval, version and idempotency checks for SHOWCASE in `src/domain.mjs`, `src/fulfillment.mjs` and `src/server.mjs`; prevent concurrent double allocation and duplicate simulated ledger events.
- [x] T027 [US2] Make 24-hour damage feedback, assignment, synthetic-only private photo access, severity review and deposit/shortfall branches work against SHOWCASE records in `src/damage.mjs`, `src/damage-policy.mjs` and `src/server.mjs`.
- [x] T028 [US2] Add explicit machine-readable simulation semantics to SHOWCASE quote, contract, payment/refund, contact and signature responses and displayed exports in `src/server.mjs`, `src/fulfillment.mjs` and `src/damage.mjs`; internal `SUCCEEDED` must never be described as actual bank receipt.
- [x] T029 [US2] Separate `managedMode` from `businessUnavailable` in `public/app.js`; show full six-role workspaces, interval availability, cart, policy consent, amounts and persistent synthetic banner while CANDIDATE stays booking-disabled.
- [x] T030 [US2] Render synchronized preparation, pickup/return actor/time and alerts in `public/fulfillment.js` and `public/app.js`; verify each action button is role-appropriate and customer sees only their order.
- [x] T031 [US2] Render technician profile, assigned cases, 24h due time, synthetic image assessment and manager/customer settlement view in `public/damage.js` and `public/app.js`; distinguish simulated refund and contact.
- [x] T032 [US2] Execute T021–T024 plus existing `test/workflows.test.mjs`, `test/fulfillment.test.mjs`, `test/damage.test.mjs`, `test/service-upgrade.test.mjs`; record normal, damage, race, object and responsive browser evidence in `specs/018-secure-synthetic-showcase/validation.md`.

**Checkpoint**: The complete synthetic workflow is available in SHOWCASE only; candidate and demo baselines still pass.

---

## Phase 5: User Story 3 — restart and isolated recovery (P2)

**Goal**: The synthetic instance survives restart and can be restored safely without data-source confusion or live overwrite.

**Independent Test**: Back up a populated SHOWCASE instance and restore into a new private file; previous sessions fail, records and snapshots remain, wrong-source/missing/corrupt manifests are rejected without target mutation.

### Tests first

- [x] T033 [P] [US3] Write failing backup/restore tests for mode and instance mismatch, corrupt hash, non-private/symlink paths, target already exists, stale sessions and no side effects in `test/018-showcase-restore.test.mjs`.
- [x] T034 [P] [US3] Write restart and older-schema migration idempotence tests; combine `test/018-showcase-migration.test.mjs` with existing `test/018-showcase-compatibility.test.mjs` for DEMO/CANDIDATE row and policy preservation. The added migration test was written after the foundational migration implementation, as recorded in validation.

### Implementation

- [x] T035 [US3] Extend verified backup manifest with SHOWCASE mode, instance/dataset versions, hash, integrity, foreign-key and restore-drill fields in `tools/backup-verify.mjs`; never include secrets or personal attachment content in the manifest.
- [x] T036 [US3] Implement SHOWCASE-only staged offline restore into an absent private target, requiring source/manifest match, checks and session epoch revocation in `tools/showcase-restore.mjs`; leave `tools/candidate-restore.mjs` candidate-only.
- [x] T037 [US3] Preserve exact SHOWCASE provenance through startup and restart, and reject incomplete/newer/foreign source without opening it for mutation in `src/runtime-provenance.mjs` and `src/server.mjs`.
- [x] T038 [US3] Execute T033/T034 with a populated two-order fixture; compare backup/restore hashes, source-file digests, `integrity_check`, `foreign_key_check` and old session refusal in `specs/018-secure-synthetic-showcase/validation.md`.

**Checkpoint**: Recovery is proven only in an isolated local rehearsal; no cloud recovery claim.

---

## Phase 6: Cross-cutting acceptance and documentation

- [x] T039 [P] Run the `npm test` script through its equivalent `node --test test/*.test.mjs` (npm executable unavailable in this shell), plus 017, candidate and demo browser scripts; record exact totals and transient failures in `specs/018-secure-synthetic-showcase/validation.md`.
- [x] T040 [P] Inspect login, customer cart/checkout, staff prep, technician damage, manager roster/settlement, owner summary and admin UI in desktop and 390px browser; attach only synthetic/redacted evidence to `specs/018-secure-synthetic-showcase/validation.md`.
- [x] T041 Confirm the intended Git package excludes private credentials, runtime databases, backups, customer photos and private WeChat config. GitHub package was audited and uploaded on 2026-11-26; subsequent staged path and private-key/token marker checks returned zero forbidden files. The historical “no Git package yet” dependency is resolved; teaching credentials and test fixtures are synthetic, not private production credentials. See `docs/Git发布包审阅.md`.
- [x] T042 Update local operator instructions and user-facing mode meaning in `README.md` and `specs/018-secure-synthetic-showcase/quickstart.md` without adding cloud preview to the core business design PDF.
- [x] T043 Map every FR-001～014 and SC-001～006 to passing test/browser/backup evidence or a named unresolved gap in `specs/018-secure-synthetic-showcase/validation.md`; T041's release-package audit is complete; actual cloud/platform acceptance remains separately recorded.

## Dependencies

`T001–T003 → T004–T011 → T012–T020 (US1) → T021–T032 (US2) → T033–T038 (US3) → T039–T043`.

US2 depends on a ready SHOWCASE dataset and managed accounts from US1. US3 can be developed against a synthetic fixture after foundation, but full recovery acceptance needs an order from US2. T004/T005 and each story's test tasks are intentionally parallel where they use different files; implementation steps touching `src/server.mjs` remain sequential. T039/T040 may run in parallel once stories are complete.

## Implementation Strategy

First deliver the US1 MVP, proving a safe private six-role instance. Then enable the simulated order lifecycle and verify business truthfulness, inventory and access. Finally add recovery and full regression. At every checkpoint preserve CANDIDATE booking denial and DEMO loopback; never publish a partial result. No Git initialization, GitHub upload or cloud permission change is authorized by these tasks.
