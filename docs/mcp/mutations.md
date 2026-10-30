# Check-in and operation handlers

This increment adds internal handlers for `create_checkin`, `undo_checkin` and `get_operation`. HTTP registration and production composition remain gated on M13's reviewed write consent and delivery lifecycle. `MutationTools` receives only the account actor's protected operation methods. It cannot select a backend, owner, stronger credential or arbitrary core executor.

## Frozen normalization

`createMutationNormalizer(approvedClaim?)` implements the trusted `OperationPolicy.normalize` boundary. It reads the current habit through the lane's expiring read capability, uses the journal's immutable command ID/clock and resolves defaults before intent persistence. Actual commands still execute through the actor and existing core transaction.

- An explicit IANA zone determines the habit's logical day, using its own start-of-day boundary and existing calendar helpers.
- A supplied occurrence must be supported by the habit, must not be a daily habit's exact time and cannot exceed the frozen clock. An explicit date/instant pair must identify the same logical day. Future dates are refused by core validation.
- Amount tracking resolves the current quick amount once. Unsupported amounts are refused. Notes use the existing core validation and are not included in operation responses.
- Time tracking freezes the occurrence instant, including the clock default. Historical fractional instants and historical offsets remain supported. Only an explicitly supplied date/instant pair requires consistency; a date-only historical entry retains the product's existing occurrence-default behavior.
- Commands use source `app`, preserving product schema 12. Service provenance stays in the operation journal.

The journal freezes the validated original arguments and command. A retry with the same operation ID returns its original result even after midnight or a habit-default edit. Changed arguments or a different mutation tool produce `IDEMPOTENCY_CONFLICT`. Invalid pre-admission input creates no product effect.

Undo resolves the original create operation through the actor's authorized journal accessor. It requires an actual `created: true` result, then carries the original check-in ID, core command ID and frozen zone into `undoCreatedCheckIn`. A daily no-op cannot become permission to delete an existing check-in. There is no generic delete or toggle tool.

The optional approved-claim normalizer is trusted service composition for M19. Without it, claims return `CONFIRMATION_REQUIRED`; no model-provided flag or token establishes approval by itself.

## Public results

`MutationTools.invoke(name, raw, context)` checks the contracted tool scope and strict schema before requesting the account lane. `get_operation` also checks the original tool's permissions. The actor remains responsible for current grant/account/client admission and recovery.

`publicOperation` selects only the contracted operation ID, tool, durable state, delivery disposition, public result and fixed error. It omits internal intent, tuple payloads, notes, fingerprints, credentials, account/grant IDs and core command IDs. Create results include their habit ID; undo results identify only the targeted check-in; claim mapping preserves the receipt's reward title, actual spend and balance. Response schemas and complete byte bounds apply after mapping. Backend acknowledgement comes only from the existing exact tuple evidence, never from pull completion or an empty queue.

## Evidence

The focused suite uses the production Node SQLite adapter, unchanged core commands and real durable journal/receipts. Its publisher/authorization callbacks isolate normalization from the separately tested recovery transport; this suite does not claim an additional live-backend or OAuth proof.

```sh
bun build services/mcp/tests/mutations.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/mutations.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/mutations.test.mjs
```

Four focused cases pass: default freezing/replay and bounded results; daily/no-op/targeted undo; DST gaps/folds and fractional historical offsets; and future/inconsistent/unsupported/unapproved inputs. Initial red was the missing handlers. The accepted M04/M04R/M12 proofs supply receipt, crash, lineage and restore boundaries. M14-M16 remain open until actual authenticated HTTP, delivery and a second replica verify the completed vertical slice.
