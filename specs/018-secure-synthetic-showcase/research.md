# Phase 0 Research: decisions and alternatives

**Date**: 2026-11-18  
**Basis**: 017 trusted proxy was complete when these decisions were written. Phase 2 has since added `showcase`; implementation evidence is in [validation.md](validation.md).

## R1. A third run mode instead of a candidate booking flag

**Decision**: Add explicit `BSR_RUN_MODE=showcase`. Treat candidate and showcase as **managed security** modes, with candidate transaction prohibition kept independent. SHOWCASE also has a temporary service-side business pause until Phase 4 validates simulation semantics. Data provenance requires exact mode match.

**Why**: `isCandidate` currently combines managed Cookie auth with “no approved catalog/transaction” behavior across `src/server.mjs` and `public/app.js`; a single `bookingEnabled` switch would leave contradictory gates and labels.

**Alternatives rejected**: (a) Enable booking in candidate: conflates unapproved real-business candidate with course simulation. (b) Expose existing demo through proxy: publishes known `Demo123!` role credentials and demo orders. (c) Duplicate the whole app: drifts security fixes and business rules.

## R2. Separate source data and identities

**Decision**: Use a new private empty DB path with `SHOWCASE` provenance and a synthetic dataset marker/version. The offline initializer writes only virtual master data and initial admin in one transaction; five remaining accounts are provisioned by admin. No shared demo account or hardcoded credential.

**Why**: `seed(db)` currently inserts `@bsr.demo`, `Demo123!` and `BR-DEMO...` orders. Candidate preflight already demonstrates read-only in-memory inspection and rejects demo data; showcase must have equally strict provenance.

**Alternative rejected**: Copy `data/bsr.sqlite` then delete known demo rows; deletion cannot prove all photos, logs and identifiers are synthetic.

## R3. SQLite schema compatibility

**Decision**: Change the `runtime_installation.run_mode` CHECK in the schema used for **new** databases to include `SHOWCASE`; do not change existing candidate/demo rows or rebuild their table solely for this mode. Existing databases continue with their original CHECK and run only in their original mode. Idempotent column/table migrations, if needed, must be tested on both old and new fixtures.

**Why**: SQLite cannot alter a CHECK constraint in place. Existing files never need to store `SHOWCASE`; rebuilding them risks damage without benefit.

**Alternative rejected**: A blanket table rebuild on all existing DBs.

## R4. Reuse 017 secure ingress and candidate identity

**Decision**: Showcase must inherit 017 trusted-local-proxy/direct TLS validation, HttpOnly+Secure+SameSite session Cookie, exact Origin and host checks, server-side role/object checks, account revocation and rate limiting. Transport and auth semantics are shared, business availability differs.

**Why**: Public access later should not regress to the loopback demo token flow. 017 validated the proxy boundary but candidate transactions remain blocked.

**Alternative rejected**: Client-side bearer tokens or public quick-login cards.

## R5. Synthetic transactions and policy truthfulness

**Decision**: Full workflow uses explicit simulation records and screens. Preserve NOK order snapshots; all other currencies are labelled indicative. Show a persistent synthetic environment marker plus contextual labels at payment, signature, refund, contract and exports. Initial policies are examples, not BSR approved.

**Why**: Constitution II forbids representing demo ledger entries as real funds or electronic signatures. A full feature demo can still exercise state and calculation behavior.

**Alternative rejected**: Renaming existing demo payment status as `SUCCEEDED` without a visible simulation qualifier.

## R6. Restore is mode-specific and offline

**Decision**: Provide a showcase-only restore command, based on the candidate restore safety properties: new target path, private regular files, matching manifest/hash/mode/instance, integrity and foreign-key checks, staged copy, revoked sessions, audit. Candidate restore stays candidate-only.

**Why**: Source confusion is the largest data contamination risk. An offline restore into a new path permits rollback without overwriting a live DB.

**Alternative rejected**: Restore directly over a running database.

## R7. Local proof before any deployment

**Decision**: Test an isolated local HTTPS proxy, six browser identities and a role/object matrix, alongside full Node regression and backup/restore. No server purchase/configuration, GitHub upload or public permission change in 018.

**Why**: Alibaba region, domain and certificate are still undecided; passing local tests does not prove cloud reachability or BSR business approval.

**Alternative rejected**: Publish first to discover policy and authorization defects remotely.
