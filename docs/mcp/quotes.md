# Reward quotes and approval evidence

`RewardQuoteStore` holds private service metadata in a separate SQLite database. `RewardPreviewTools` obtains the existing core reward preview through the account actor's read capability. Preview neither spends nor reserves coins, uploads product records or creates a command receipt. A read-only connection needs only `coins:read` to request a quote.

## Binding and lifetime

A quote binds the verified account, actual OAuth client, intended UUID v4 operation, reward ID/version/title/cost, IANA zone and five-minute expiry. Its original grant is retained as provenance. Output contains the reward, observed balance and quoted balance-after, expiry, opaque token and fixed-origin `/mcp/reward-confirmation` URL. Negative observed balances remain valid; insufficient quoted funds produce null balance-after and cannot be approved.

An unchanged, unexpired preview retry returns the same quote and expiry, including after reopening SQLite. A different reward or zone under the same operation ID conflicts. A changed reward version or expired quote creates a new token and invalidates the old approval. Balance movement alone does not invalidate an already displayed quote; actual affordability is checked in the core claim transaction. No global reservation or nonnegative balance guarantee is introduced.

The token authenticates an opaque random quote ID and the complete immutable payload with a domain-separated HMAC. Payload, indexed account/client/operation fields and separately authenticated approval evidence must agree. The exact token is not stored in SQLite. The external 32-byte key is copied at construction and cleared at close; it must survive restart and be backed up separately. Lost keys or damaged state fail closed rather than resetting history.

## Trusted API

```ts
const quotes = new RewardQuoteStore({ location, key, publicOrigin });
quotes.issue({ accountId, clientId, grantId }, input, corePreview);
quotes.view(token, verifiedBrowserAccountId);
quotes.approve(token, { accountId, providerSessionId });
quotes.admit(token, { accountId, clientId, operationId });
quotes.close();
```

These are private service methods. `approve` must be called only by an authenticated same-account browser POST after Origin and CSRF validation. A model token or boolean cannot invoke it through MCP. `view` never approves. M18 supplies the browser routes and visible exact-cost confirmation; those routes are not implemented by this storage increment.

`admit` verifies existing human approval, account/client/operation binding and expiry, then returns frozen quote data to the trusted normalizer. It is a read and cannot consume or reserve approval before journal preparation. The immutable operation binding prevents use for another operation; the durable journal supplies exactly-once intent and receipt replay. A crash between approval verification and journal preparation therefore does not strand an otherwise unused operation. Expired or replaced approval cannot admit new intent. An already journaled retry replays its frozen receipt without reevaluating the current quote or an edited/deleted reward.

`approvedClaimNormalizer(quotes)` checks the approved quote against the current undeleted/unarchived reward stamp and cost after the actor's fresh pull. It returns only the existing core `claimReward` command with the expected stamp and frozen quote zone. The core still checks current local affordability atomically. A changed reward requires a new preview and approval; ordinary affordable balance movement is accepted. Public claim registration remains gated on M18/M19 integration and review.

## Storage and limits

The database, sidecars and physical directory must be private and owned by the service. Full synchronous WAL storage and exact version/schema checks reject unknown or incomplete files. Authenticated database metadata binds the key and public origin before any quote can be issued or approved. Reopening with another key or origin refuses startup. Schema 12 and the phone database remain unchanged. The default lifetime retained limit is 10,000 quotes across this service database; exceeding it returns `RATE_LIMITED`. Namespace lookup, capacity decisions and insertion share one immediate write transaction, so concurrent issuers cannot overfill the retained limit. Replacing an expired or changed-version quote in the same namespace uses its existing slot. There is no implicit history pruning or key-reset API.

## Evidence

```sh
bun build services/mcp/tests/quotes.test.ts --target=node --packages=external --outfile=services/mcp/.artifacts/quotes.test.mjs
/tmp/node-v24.22.2-darwin-arm64/bin/node --test services/mcp/.artifacts/quotes.test.mjs
```

Eight focused real Node/SQLite cases pass. They cover stable restart tokens, read-only views, authenticated approvals, account/client/operation swaps, token and stored-state tampering, indexed-identity retargeting, expiry, changed versions, insufficient/negative balances, key/origin refusal and concurrent capacity. A production core preview leaves the product outbox unchanged, and a real core claim accepts affordable balance movement after approval. Behavioral reds caught pre-journal approval consumption and index fields that could retarget an otherwise authentic payload. Independent review then reproduced mixed-key issuance and two retained quotes in a one-slot store; both now have passing regressions, including two synchronized real SQLite workers. The read actor and authorization callbacks in the core-preview case isolate those already tested boundaries; this is not a browser, live delivery or remote-client acceptance claim.
