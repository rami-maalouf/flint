# Habit System Full Stack

This fork preserves habit-system history through `492592d`. Existing product behavior and the local SQLite domain remain in force. The inherited plan and task ledger describe the original app; this plan governs the new backend work.

## Boundaries and invariants

- Local commands commit product data and their outbox atomically. Network availability never gates a habit action.
- Snapback 4 owns password identity, private server records, generated APIs, live change notifications and immutable server releases.
- The existing sync engine owns conflict reconciliation and admission of immutable economic facts. The backend preserves conflicting immutable variants rather than silently overwriting them.
- Each server record belongs to the authenticated principal. No caller supplies another account's owner.
- The new app has separate bundle, App Group, scheme, widget and EAS identities. It cannot open the original app's database or receive its updates.
- Sessions live in SecureStore; passwords are never persisted. A local database remains bound to its first backend account across sign-out.
- Snapback is the only active sync provider in this fork, as selected by the user. Retain the iCloud adapter for reference; never run both against the shared queue.

## Ordered work

1. Preserve the repository and establish Snapback schema, account isolation, conflict handling and durable change ordering. Verify against a real temporary server.
2. Establish the new native identity and backend session boundary. Verify identity tests, sign-up/login/session restore and account-switch rejection.
3. Connect the existing outbox to Snapback and add the account/sync screen. Verify offline edits, retry, restart and two-client convergence.
4. Build native Linux ARM runtime, stage an isolated deployment, configure TLS and resource bounds, and rehearse backup/restore.
5. Verify the current rendered app, run validate and native tests, obtain independent review, record evidence and publish the implementation branch.

## Acceptance

An account can make local changes offline, restart, reconnect and see them on a second client. Replays do not duplicate immutable facts. Older mutable uploads cannot replace newer values. Accounts cannot read or modify each other's records. Sign-out never deletes local data. The original repository, live app and VPS services remain intact.

The operational record must distinguish verified capabilities from unavailable ones. Snapback 4 MCP is currently unverified and is not part of the running integration. Optional product features such as media uploads, jobs and presence are added only when the app has a concrete use for them.
