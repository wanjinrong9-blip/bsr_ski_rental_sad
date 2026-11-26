# Local validation guide: 018 secure synthetic showcase

**Status (2026-11-20)**: Phase 1–5 have passed isolated local checks. The six-role simulated workflow, private verified backup and offline restore are implemented. The full Node suite passed **191/191**; the trusted-proxy browser suite completed desktop and 390px booking, staff preparation and handoff. The actual release package still needs a private-file audit once a repository package exists. These are local operator instructions, not cloud deployment instructions.

## Preconditions

- 017 trusted proxy and candidate security regression pass locally.
- Create *new*, private, empty data and backup directories outside `public/` and outside the existing `data/bsr.sqlite` / candidate DB. Use an isolated local HTTPS test proxy or valid loopback TLS setup. Never reuse demo DB or real customer information.
- Choose only fictional names, stores, contact values and non-personal generated attachment images. Prepare six private unique passwords out of band; never paste them into a repository file, test log or screenshot.

## Local operator sequence

1. Set explicit `BSR_RUN_MODE=showcase`, `BSR_DB_PATH`, `BSR_BACKUP_DIR`, `BSR_PUBLIC_ORIGIN` and the appropriate 017 trusted entry configuration in a private shell environment. Keep proxy secret out of source control.
2. Run `node tools/showcase-setup.mjs preflight` and expect `needs_init` with no DB created. Probe a known demo/candidate DB path and expect source rejection without changing either file.
3. Run `node tools/showcase-setup.mjs init` interactively; password input is hidden and accepted only in the terminal. Check `ready`, one provenance row and one synthetic dataset marker. Re-run init and expect refusal/no duplicate rows. No `@bsr.demo`, `Demo123!` or `BR-DEMO` records may exist. An interrupted initialization may leave a non-ready schema file; inspect it rather than reusing or overwriting it.
4. Start the service behind the local HTTPS proxy or the validated loopback HTTPS configuration. The first administrator signs in, provisions five unique fictional private roles in “账号与权限”, and delivers each one-time password out of band. Verify each role's first-login change requirement and account disable/logout behavior. Each role can read the fictional catalog after login; the administrator can inspect account events. The login, catalogue, order and staff pages label the data as synthetic.
5. Customer selects a date window (pickup after 09:00; return before 16:00) and sees per-window remaining quantity, adds goggles/knee pads plus main equipment to cart, accepts the synthetic damage rule and creates a simulated reservation. Check NOK rent and every item’s `round(referenceValueNok * 0.08)` deposit.
6. Staff clocks in, views shift/alerts, prepares units, verifies pickup code and handles handoff. Customer sees the same stage and named responsible worker. Staff accepts return; technician records synthetic photo and severity within 24 hours. Manager reviews settlement; owner sees cross-store aggregate; admin inspects audit. Repeat with undamaged return and verify simulated auto-refund.
7. Try a concurrent last-unit booking, duplicate submit, cross-customer order read, unassigned technician read, wrong-store worker update, stale session, invalid Origin/Host/proxy secret and a malicious attachment. All denied paths must have zero unauthorized side effects.
8. Run full Node tests and six-role browser suite at desktop and 390px viewport. Record failures rather than marking the package complete.
9. Create a consistent private backup using `node tools/backup-verify.mjs --source <SHOWCASE_DB> --output <PRIVATE_BACKUP_DIR>`. Stop the SHOWCASE service before the offline restore. Set the same SHOWCASE environment with `BSR_DB_PATH` pointing to a **new, absent** file outside both `public/` and the backup directory, plus `BSR_RESTORE_OPERATOR`. Run `node tools/showcase-restore.mjs --backup <backup.sqlite> --manifest <backup.sqlite.json>`. It checks the hash, SQLite integrity, zero foreign-key errors, SHOWCASE instance/dataset marker and manifest, then revokes all pre-restore sessions. Never point this command at the running source file or a CANDIDATE/DEMO file; never overwrite the original. Verify two order snapshots and source-file digest in an isolated rehearsal.

## Release gate

Only mark 018 complete when FR-001～014 and SC-001～006 have evidence, the desktop/390px booking and handoff click-through passes, and the intended release package is checked for private files. A later deployment task must separately verify cloud domain/TLS/permissions. BSR policy approval and real payments/signatures remain separate decisions.
