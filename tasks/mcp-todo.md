# Habit System MCP task ledger

Plan: [mcp-plan.md](mcp-plan.md). Created against fullstack main `1985795` on 2026-10-30. Verified progress is recorded below and in `../checkpoints.md`. Existing product/fullstack todos remain historical authority for their own work.

For every task: write the meaningful failing proof/test first, implement the bounded slice, run its verification, obtain independent review where indicated, add an M-prefixed checkpoint, and commit with a lowercase conventional message. Split oversized work without changing the acceptance contract. Do not mark a proof passed from static reasoning alone.

## Feasibility

- [x] M01: prove supported OAuth identity/runtime/client integration; record provider, runtime and pinned versions (gate A).
- [x] M02: freeze scoped tool, result, date, confirmation and operation contracts.
- [x] M03: prove awaited SQLite transactions and genuinely read-only bootstrap (gate B).
- [x] M04: prove receipt/journal linkage and exact delivery evidence through crash windows (gate C).
- [ ] M04R: prove independent recovery-head detection of incomplete restored journals (gate D).

## Read-only service

- [ ] M05: establish isolated service install/build/test boundary; preserve mobile dependency graph.
- [ ] M06: persist verified browser identity and encrypted independent Snapback session custody.
- [ ] M07: complete discovery, PKCE, consent, token validation and registration protections.
- [ ] M08: implement durable isolated account replicas with one owner and serialized work.
- [ ] M09: deliver habits/today/status over real authenticated HTTP MCP (checkpoint R).
- [ ] M10: deliver bounded history continuation and current stack projections.
- [ ] M11: deliver coin/reward reads using read-only upstream authority (checkpoint S).

## Durable mutations

- [ ] M12: implement durable operation journal, crash recovery and delivery evidence.
- [ ] M13: add scoped write sessions, revoke/commit ordering and a mixed-queue delivery barrier.
- [ ] M14: deliver deliberate check-ins with stable operation IDs and frozen dates.
- [ ] M15: deliver targeted undo of this service's actual created check-ins.
- [ ] M16: expose authorized durable operation lookup (checkpoint W).
- [ ] M17: create operation-bound reward quotes without spending/reservation.
- [ ] M18: render and verify authenticated cost confirmation with safe POST approval.
- [ ] M19: deliver confirmed reward claims with existing offline-overspend semantics (checkpoint C).

## Release

- [ ] M20: finish connections, revocation and explicit owner consent to resume paused deliveries.
- [ ] M21: bound resources and expose redacted diagnostics and health.
- [ ] M22: verify and document exact real-client compatibility.
- [ ] M23: deploy isolated Linux ARM64 staging and verify shared proxy routing.
- [ ] M24: rehearse private off-host backup and isolated operation-safe restoration.
- [ ] M25: complete inherited/service gates and independent final verification.
- [ ] M26: activate reviewed release, demonstrate synthetic public flow, open/link PR and hand over.

## Release acceptance

- [ ] All 15 v1 tool contracts implemented with invocation-time scope enforcement.
- [ ] Read grants cannot write, including during first sync and reconciliation.
- [ ] Repeated/uncertain operations do not create duplicate effects after restart or tested restore.
- [ ] An older backup missing a later operation is detected and write-fenced before a retry can duplicate it.
- [ ] Coordinated rollback to matching older snapshots stays write-fenced without independent completeness evidence.
- [ ] Revoked/mixed-grant outbox work cannot drain under a different credential without explicit owner re-consent.
- [ ] Reward approval, local transaction checks and negative offline-convergence behavior match the product spec.
- [ ] No account/session/private fixture leaked; phone and other services remain intact.
- [ ] Service lint/typecheck/unit/integration/protocol/build and root validate/native/backend gates pass.
- [ ] Advertised clients have actual connection evidence; unavailable clients are labeled unverified.
- [ ] Backup, key recovery, rollback and pending-operation restoration demonstrated with synthetic data.
- [ ] Independent reviewer has no unresolved blocking findings; evidence and PR are linked.
- [ ] User sign-in, if still pending, is reported as pending without claiming their account is connected.
