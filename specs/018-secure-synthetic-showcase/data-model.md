# Data Model: SHOWCASE provenance and synthetic rental state

**Status**: 来源与结构模型已在 Phase 2 接入；合成主数据和业务记录仍待 Phase 3/4 创建。所有未来业务记录必须为虚构数据。

## Mode and provenance invariants

| Entity | Existing storage | Required 018 meaning and constraints |
| --- | --- | --- |
| `runtime_installation` | singleton row: `run_mode`, `instance_id`, `schema_version`, `init_state`, initial admin | New empty SHOWCASE DB accepts `run_mode='SHOWCASE'`; exactly one row; 128-bit-or-greater random instance ID; `READY` only after dataset+admin complete; never update DEMO/CANDIDATE row into SHOWCASE. |
| `runtime_checks` | phase/result/reason/time | Record INIT, START and RESTORE checks without secret values. Only matching ready source may open. |
| `initial_admin_event` | admin, operator, result/time | Initial administrator created once with controlled terminal input. The email cannot end `@bsr.demo`; no known password. |
| `app_migrations` | migration name/time | New schema and synthetic dataset migration names are idempotent. Mode-dependent catalog upgrade must not take the old demo seeding branch for SHOWCASE. |
| `showcase_dataset` (new) | none | Singleton `instance_id`, `dataset_version`, `synthetic=1`, `created_at`, provenance description. Must match `runtime_installation` and cannot be removed while ready. No real-source ID or personal data. |

`SHOWCASE` is a new DB **identity**, not a flag on a candidate DB. New schema CHECK may include the third value. Existing files retain their previous CHECK and data; no table rebuild is required solely to admit SHOWCASE in a new file.

## Synthetic master data

| Entity | Required attributes / invariants | Relations |
| --- | --- | --- |
| `stores` | At least two clearly fictional Norwegian locations; display label marks synthetic. Do not use actual BSR operating addresses. | 1:n variants' store policies, units, staff, shifts. |
| `variants` | Fictional category, style, size, skill where relevant, `retail_nok >= 0`; accessories include goggles/knee pads. Existing migrations provide `retail_nok`. | 1:n units; 1:n policies. |
| `units` | Globally unique and stable `inventory_no`; availability/maintenance state, owning/current store and cleanliness as supported by existing schema; no reused demo inventory number. | n:1 variant/store; referenced by reservations and damage. |
| `price_policies` | `version >= 1`, `daily_nok >= 0`, `deposit_nok = round(variant.retail_nok * 0.08)` in example snapshot; example/pseudo-approval clearly identified as simulation. Effective date in Europe/Oslo business rules. | n:1 variant and store; each reservation item keeps policy ID/version and monetary snapshot. |
| Damage/late rules | Separate versioned examples; 24-hour assessment deadline and new-customer 2-hour lateness grace retained; not represented as BSR commercially approved. | Captured by order/contract consent and quote. |

Use existing `catalog-upgrade` fields. Its current `runMode==='candidate'` exclusion is insufficient for a third mode: implementing 018 must split structural migration from demo-only data population, so neither candidate nor showcase receives `coreValues` updates, added demo variants, `BSR-...` stock or demo account-name edits automatically.

## Identity and privacy

| Entity | Required attributes / invariants |
| --- | --- |
| `users` | Six unique role accounts: `customer`, `staff`, `manager`, `contractor`, `owner`, `admin`. Initial admin has controlled private credential. Other accounts created through admin with individual one-time strong passwords and `must_change_password=1`; no self-registration. Staff/manager store assignment as needed. All names/emails fictional but cannot use `@bsr.demo`. |
| `sessions` | Hashed token, expiry, auth epoch, revocation; managed Cookie only. Restore revokes sessions and increments account auth epoch. No token in URL, static assets or database backups distributed to viewers. |
| `employee_profiles`, `shifts`, `attendance` | Fictional worker profiles and at least one shift per operational role; only authorized role sees private detail. |

## Transaction aggregates

| Aggregate | Required invariants |
| --- | --- |
| `reservations` + `reservation_items` + `rental_units` | One customer and store, chosen pickup/return interval, unique code and pickup code, clear status. Every item records policy and NOK rent/deposit snapshot; each assigned physical unit is unique in overlapping active intervals. Reservation request key prevents duplicate creation. |
| `payments` | Existing simulated event table; every entry in SHOWCASE is marked as synthetic in output and audit. Unique idempotency key. A `SUCCEEDED` internal status means only simulation succeeded; no real provider reference or bank data. |
| `inspections` + `damage_cases` + photos/events/settlements | One inspection per reservation+unit; assigned assessor, time due within 24h, permitted severity, synthetic photo source, manager review, fee/payout/contact status. Photo files are private and synthetic. |
| `maintenance`, `stock_events`, `audit_log` | Technician assigned only their work; stock movements retain before/after actor and time; append-only audit of setup, reservations, settlement and restore. |

State transition details remain governed by existing business modules and contracts. 018 must not bypass their server validation to make a demo faster.

## Recovery integrity

Backup manifest adds/retains `runMode=SHOWCASE`, `instanceId`, schema/dataset versions, file hash, integrity result, foreign-key count and restore drill result. Source and target must match mode, but a restored copy receives new session epoch/revocation audit. Restore only to a new private file, never over an active DB. Manifest or DB mismatch aborts before target promotion.

## Data transition and migration strategy

1. Before any source change, capture exact schema and row counts from untouched DEMO/CANDIDATE fixtures.
2. For new SHOWCASE DB, create common schema with `SHOWCASE` in CHECK and structural catalog columns; do **not** call `seed(db)` or demo-only `upgradeCatalog` population.
3. Insert synthetic dataset and source marker atomically under an initialization lock; incomplete DB remains non-ready.
4. On old DEMO/CANDIDATE DB, migration must be repeatable without altering run mode, initial credentials, historic policy/quote snapshots or existing order rows.
5. Verify `PRAGMA integrity_check='ok'`, `foreign_key_check=[]`, per-mode row counts and file digests as appropriate; exercise restart and isolated restore.
