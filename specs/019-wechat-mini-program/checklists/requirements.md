# Specification Quality Checklist: 网页与微信小程序互联

**Purpose**: Validate the 019 written specification before implementation  
**Created**: 2026-11-18  
**Spec**: [spec.md](../spec.md)

## Content quality

- [x] User goals, business value and actor boundaries are stated in testable terms.
- [x] Mini Program and Web deployment meaning is corrected without treating a document's instructions as the user's request.
- [x] Normal, failure, concurrent and security scenarios are included; no unresolved template markers.
- [x] Current platform dependencies and 018 implementation dependency are disclosed.

## Requirement completeness

- [x] Website QR has both truthful OFF state and real platform-issued READY state.
- [x] Customer Mini scope and five staff/admin Web scope are explicit.
- [x] Shared cart, physical inventory, order, policy and cross-role progress have one server authority.
- [x] WeChat OpenID binding is explicit; employee role escalation and session replay are prohibited.
- [x] NOK, 8% reference-value deposit, 09:00/16:00, two-hour new-customer grace, 24-hour damage and simulation semantics are preserved.
- [x] Website ICP/domain and Mini Program filing/review are identified as separate platform gates.
- [x] FR-001～015, SC-001～007 and T001～T040 are numbered and cross-checkable.
- [x] No GitHub upload, cloud publication, real payment or real WeChat scan is claimed.

## Notes

This checklist reviews documentation quality only. All implementation tasks in `tasks.md` remain open; 018 is not yet implemented, and real WeChat platform credentials/domain are not available to this package.
