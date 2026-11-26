# Interface and operation contracts: secure synthetic showcase

**Status**: proposed interfaces and behavior, not yet implemented. Existing endpoint names stay stable unless an implementation task establishes a versioned replacement.

## 1. Offline preflight and initialization

| Operation | Preconditions | Success | Failure and side effects |
| --- | --- | --- | --- |
| `showcase-setup preflight` | `BSR_RUN_MODE=showcase`, explicit private DB and backup paths, valid local TLS or 017 trusted proxy settings | Structured non-secret result: `runMode`, `status=needs_init|ready`, optional instance ID/version | Missing/weak entry, public path, mode mismatch, unfinished/damaged DB: stable error code; **no new DB file or data mutation**. |
| `showcase-setup init` | TTY, empty designated DB, operator ID, non-demo admin email, strong private password, single initializer lock | Creates admin, provenance, synthetic dataset and ready marker transactionally; prints no password | Duplicate init, weak credential, lock contention or any dataset write failure: no partial `READY` state, no duplicate master rows; safe retry only after verifying/removing incomplete isolated file. |
| Admin provision five accounts | Logged-in SHOWCASE admin, allowed role, fictional identity, unique email, private strong one-time credential | New account scoped to role/store; first login must change password; audit | Wrong role, duplicate email, demo domain/known password or non-admin: 4xx, no user created. |

Environment contract: no new `BSR_RUN_MODE` default; omitted value stays `demo`. Showcase requires the candidate-grade network/secret checks, while candidate remains booking-disabled. On trusted proxy transport, app binds only loopback and rejects untrusted Host/Origin/proxy headers before any route, including health/static.

## 2. `GET /api/bootstrap` and identity

SHOWCASE bootstrap response must contain `runMode:'showcase'`, `demo:false`, `synthetic:true`, `capabilities` with managed account behavior and `bookingEnabled:true`, an unambiguous customer-facing simulation banner, and no `demoLogin` passwords/accounts. Candidate response stays `bookingEnabled:false`; demo keeps its local behavior. Responses must not expose setup secrets, dataset source file paths, session tokens or other users' private profiles.

`POST /api/auth/login`, `POST /api/auth/change-password`, `POST /api/auth/logout`, `GET /api/me`: same managed Cookie and role/object guards as candidate. Cookie must be Secure, HttpOnly and SameSite; logout, disable, password change and restore revoke the previous session. Failed logins share candidate account/source rate limits. Mutation requests require exact trusted Origin and session proof.

## 3. Business capability matrix

| Area / existing route family | DEMO | CANDIDATE | SHOWCASE |
| --- | --- | --- | --- |
| Login | Local demonstration identities | Managed private identity | Managed private identity |
| Catalog/quote/cart/availability | Demo data, functional | Empty or explicitly withheld | Synthetic master data, functional; interval stock server-checked |
| Reservation/contract/simulated funds | Functional demo | Denied until BSR approval | Functional **simulation** with NOK snapshots and unmistakable label |
| Staff preparation/pickup/return | Functional demo | No unapproved transaction | Functional against SHOWCASE unit/order IDs |
| Damage/maintenance/settlement | Functional demo | Policy-limited | Functional synthetic assessment, 24h deadline, simulated refund/shortfall |
| Roles/rosters/attendance/alerts | Demo data | Managed permissions | Managed permissions plus shared synthetic order state |
| Admin account/audit | Existing demo behavior | Managed/private | Managed/private, SHOWCASE-only source |

Specific existing API families to inspect include `/api/catalog`, `/api/quote`, `/api/cart`, `/api/reservations`, `/api/policies`, `/api/maintenance`, `/api/attendance`, `/api/users`, `/api/health`, SSE and the fulfillment/damage endpoints in `src/server.mjs`. Reusing a route does not waive per-object authorization.

## 4. Synthetic business rule contract

- Quote requires store, pickup/return interval, variant and quantity; include available count, selected policy ID/version, `referenceValueNok`, `depositRate=0.08`, integer NOK rent/deposit and ordered line items. Confirm must recheck real remaining single-unit availability; concurrent last-unit attempts yield at most one success.
- Order confirmation requires current version of damage consent and explicit acceptance. It writes immutable quote/contract monetary snapshots; policy edits apply to new orders only.
- Payment/signature/refund/contact endpoints may advance **simulated** state only. Responses and rendered/printed contracts include `simulation:true` or equivalent unambiguous label. No actual provider credentials or external calls.
- Fulfillment enforces assigned worker/store and actual unit state. Return triggers a 24-hour assessment deadline. Damage severity and photo rules use synthetic private files; final settlement partitions deposit deduction, refundable remainder and shortfall. Duplicate operation key does not repeat mutation.
- Every state-changing action is persisted once and broadcast to relevant roles; customers see their own responsible step and status, not other customers' details.

## 5. Backup and restore

`showcase-restore` is offline only, requires a private backup plus matching manifest and operator ID, targets a **new** absent file, and verifies `SHOWCASE`, instance ID, schema/dataset version, hash, integrity and foreign keys. It stages a copy, revokes all sessions and audits restore before promotion. Candidate and demo backups must be rejected. Any failure leaves the target absent and source untouched; the running DB is never overwritten.

## 6. Error semantics and non-leakage

Return stable public error codes for invalid mode/source, not-ready dataset, credential weakness, booking conflict, invalid consent, permission denied, stale operation and restore mismatch. Error bodies and logs may name the category but must never echo passwords, proxy secrets, session tokens, photos or private filesystem paths. Rejected requests must leave business row counts/versions unchanged.
