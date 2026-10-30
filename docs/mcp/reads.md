# Read handlers and continuation

`ReadTools` implements the ten non-confirmation read tools against the account actor's expiring read capability. Strict input and invocation scopes are checked before account work. The actor owns pull, admission, observation metadata and immutable request clocks; handlers reuse the existing habit, today, stack, ledger and reward queries. Product schema 12 is unchanged.

Check-in history uses a bounded SQL keyset over effective rows (`deleted_at IS NULL`, `state_suppressed = 0`) ordered by logical date, creation instant and id descending. Date bounds are inclusive. Notes are excluded from the SELECT and result unless the current grant includes `habits:notes:read`. A history day can span pages. This query does not use the phone's grouped whole-day prefix API.

Each page is a new observation, not a retained snapshot. Concurrent insertions before the continuation appear after refreshing the first page. Deletions disappear. Changes to ordering fields can move a record across a continuation; restart the listing to see all concurrent changes.

The external 256-bit cursor key must survive service restart. AES-GCM tokens bind account, stable OAuth client, tool and normalized filters, including the zone and notes permission where relevant. They expire after 24 hours. Tampered, expired or mismatched tokens fail before opening the replica. Supported imported order keys longer than 255 characters work; an ordering key that cannot fit the 4096-character cursor budget returns a clear bounded error without emitting an unusable continuation.

Pages default to 50 and accept 1-100 rows. Page builders shorten complete results to the 131072-byte UTF-8 envelope budget and continue from the last returned row. One oversized item fails clearly. Listings are bounded to 10000 habits/rewards; today supports 100 habits, stack projections 1000 habits, and analytical projections 200000 check-in rows. The limits bound current shared-core queries; larger projections return `RATE_LIMITED` with guidance to use a paged read. History itself does not load a full prefix.

The HTTP wrapper uses the [official SDK per-request factory](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html), its maintained stateless fallback for 2025 protocol traffic, and [resource-server bearer validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). Every exchange gets its own admitted context. It exposes no mutation tool in this increment. Titles and notes remain untrusted stored data.

## Evidence

Run the focused real-Node handler suite and the authenticated HTTP suite from the repository root:

```sh
bun build services/mcp/tests/reads.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/reads.test.mjs
node --test services/mcp/.artifacts/reads.test.mjs
bun build services/mcp/tests/http-reads.test.ts --target=node --packages=external --outfile services/mcp/.artifacts/http-reads.test.mjs
node --test services/mcp/.artifacts/http-reads.test.mjs
```

Use exact Node 24.22.2. The HTTP test creates disposable synthetic Snapback accounts, seeds through real core commands and sync, completes actual browser forms/consent/PKCE exchange, then calls all ten tools with SDK clients using modern and legacy protocol modes. It checks two-account isolation, 105-row history continuation, note omission, explicit cached reads after network failure and zero provider mutations during authorized reads. These are automated SDK results, not evidence of a private ChatGPT or Claude connection.
